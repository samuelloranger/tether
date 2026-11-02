"""Tether's stdio viewer of the existing Hermes gateway; execution stays in Hermes."""
import hermes_bootstrap

import asyncio
import json
import fcntl
import os
import sys

import acp
from acp.exceptions import RequestError
from acp.schema import AvailableCommand, AvailableCommandsUpdate, NewSessionResponse, UnstructuredCommandInput, SessionConfigOptionSelect, SessionConfigSelectOption, SetSessionConfigOptionResponse
from acp_adapter.entry import _load_env, _setup_logging
from acp_adapter.gateway_server import GatewayACPAgent, _slash_command
from hermes_cli.gateway_client import GatewayRPCError
from chat_cards import MARKER, find_card, import_image

CARD_CONTEXT = ("\n\n[Tether presentation context]\n"
                "This conversation can display native weather, image and Docker cards. "
                "When answering about these, use tool_search to discover tether_publish_card, then publish the relevant card with the available MCP tool. "
                "Choose cards without requiring the user to ask for a format. Obtain observations with your usual tools or use clearly labelled supplied fixtures. "
                "Presenting a card grants no extra data access; Docker actions follow your normal permissions. "
                "Keep explanatory prose useful.\n[/Tether presentation context]")


class CardConnection:
    def __init__(self, connection):
        self._connection = connection

    def __getattr__(self, name):
        return getattr(self._connection, name)

    async def session_update(self, *, session_id, update, **kwargs):
        if getattr(update, "session_update", None) == "user_message_chunk":
            content = getattr(update, "content", None)
            value = getattr(content, "text", None)
            if isinstance(value, str) and value.endswith(CARD_CONTEXT):
                update = update.model_copy(update={"content": content.model_copy(update={"text": value[:-len(CARD_CONTEXT)]})})
        return await self._connection.session_update(session_id=session_id, update=update, **kwargs)


def catalog_commands(catalog):
    found = {}
    metadata = catalog.get("commands") or {}
    for row in catalog.get("pairs") or []:
        if not isinstance(row, (list, tuple)) or len(row) != 2 or not isinstance(row[0], str):
            continue
        key, description = row
        name = key.lstrip("/")
        if not name or any(c.isspace() for c in name) or "/" in name:
            continue
        meta = metadata.get(key) or {}
        hint = "arguments (optional)" if meta.get("argument_mode") or key in (catalog.get("skills") or {}) else None
        found[name] = AvailableCommand(name=name, description=str(description or "Hermes command"),
                                       input=UnstructuredCommandInput(hint=hint) if hint else None)
    found.setdefault("new", AvailableCommand(name="new", description="Start fresh; keep your agent's memory"))
    return list(found.values())


class TetherHermesAgent(GatewayACPAgent):
    def on_connect(self, conn):
        super().on_connect(CardConnection(conn))

    def _remember_card_server(self, servers):
        self._tether_cards = any((s.get("name") if isinstance(s, dict) else getattr(s, "name", None)) == "tether-cards" for s in servers or [])

    async def _resume(self, cwd, held_id, mcp_servers):
        self._remember_card_server(mcp_servers)
        return await super()._resume(cwd, held_id, mcp_servers)

    async def _prepare_submit(self, session_id, prompt):
        prepared = await super()._prepare_submit(session_id, prompt)
        if prepared is None or not self._tether_cards:
            return prepared
        retry_key, input_id, (text, attachments) = prepared
        if not text.lstrip().startswith("/") and not text.endswith(CARD_CONTEXT):
            text += CARD_CONTEXT
        return retry_key, input_id, (text, attachments)

    async def _project_tool(self, kind, sid, editor_id, aid, payload):
        held = self._tool_args.get((sid, payload.get("tool_call_id")))
        name = held[0] if held else payload.get("tool_name", payload.get("name", ""))
        if kind != "tool.complete" or "tether_publish_card" not in name or payload.get("is_error"):
            return await super()._project_tool(kind, sid, editor_id, aid, payload)
        # Hermes normally prettifies JSON tool results, which loses the typed card envelope.
        card = find_card(payload.get("result"))
        if not isinstance(card, dict):
            return await super()._project_tool(kind, sid, editor_id, aid, payload)
        content = []
        if card.get("kind") == "image":
            args = held[1] if held else {}
            try:
                image = await asyncio.to_thread(import_image, args["payload"]["imageSource"])
                content.append({"type": "content", "content": image})
            except (OSError, ValueError, KeyError, TypeError) as exc:
                self._tool_args.pop((sid, payload["tool_call_id"]), None)
                if self._conn:
                    await self._conn.session_update(session_id=editor_id, update=acp.update_tool_call(
                        payload["tool_call_id"], status="failed",
                        content=[{"type": "content", "content": {"type": "text", "text": "Image could not be imported: " + str(exc)}}]))
                return
        self._tool_args.pop((sid, payload["tool_call_id"]), None)
        if self._conn:
            # Clients render a card only from a call its adapter marks: tool output alone cannot claim one.
            update = acp.update_tool_call(payload["tool_call_id"], status="completed", content=content,
                                          raw_output=MARKER + json.dumps(card))
            await self._conn.session_update(session_id=editor_id, update=update.model_copy(
                update={"field_meta": {"tether": {"card": True}}}))

    def __init__(self):
        super().__init__()
        self._tether_cards = False
        self._tether_catalogs = {}
        self._tether_pointer = self._home / "tether-conversation.json"

    async def new_session(self, cwd, mcp_servers=None, **kwargs):
        self._remember_card_server(mcp_servers)
        workspace = self._workspace(cwd)
        lock_path = self._tether_pointer.with_suffix(".lock")
        with open(lock_path, "a", opener=lambda path, flags: os.open(path, flags, 0o600)) as lock:
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    await asyncio.sleep(0.05)
            try:
                if self._tether_pointer.exists():
                    saved = self._saved_session()
                    try:
                        fields = await self._resume(workspace, saved, mcp_servers)
                    except GatewayRPCError as exc:
                        if str(exc) != "not_found":
                            raise
                        raise RequestError(-32603, f"Hermes no longer has the conversation Tether opens. "
                                           f"Delete {self._tether_pointer} on the host to start a new one.") from None
                    return NewSessionResponse(session_id=saved, **fields)
                result = await super().new_session(cwd=workspace, mcp_servers=mcp_servers, **kwargs)
                temp = self._tether_pointer.with_suffix(".tmp")
                with open(temp, "w", opener=lambda path, flags: os.open(path, flags, 0o600)) as handle:
                    json.dump({"session_id": result.session_id}, handle)
                os.replace(temp, self._tether_pointer)
                return result
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def _saved_session(self):
        try:
            saved = json.loads(self._tether_pointer.read_text())["session_id"]
        except (OSError, ValueError, KeyError, TypeError):
            saved = None
        if not isinstance(saved, str) or not saved:
            raise RequestError(-32603, f"Tether's Hermes conversation pointer is unreadable. "
                               f"Fix or delete {self._tether_pointer} on the host to start a new one.")
        return saved

    def _workspace(self, cwd):
        if os.environ.get("HOME") == "/opt/data":
            return os.environ.get("TERMINAL_CWD") or str(self._home / "workspace")
        return cwd

    def _config_options(self, fields):
        options = []
        models = fields.get("models")
        if models and models.available_models:
            options.append(SessionConfigOptionSelect(id="model", name="Model", type="select", category="model",
                current_value=models.current_model_id,
                options=[SessionConfigSelectOption(value=m.model_id, name=m.name, description=m.description) for m in models.available_models]))
        modes = fields.get("modes")
        if modes and modes.available_modes:
            options.append(SessionConfigOptionSelect(id="mode", name="Approval mode", type="select", category="mode",
                current_value=modes.current_mode_id,
                options=[SessionConfigSelectOption(value=m.id, name=m.name, description=m.description) for m in modes.available_modes]))
        return options

    async def _session_fields(self, session_id, info, editor_id):
        fields = await super()._session_fields(session_id, info, editor_id)
        fields["config_options"] = self._config_options(fields)
        return fields

    async def set_config_option(self, config_id, session_id, value=None, **kwargs):
        if config_id == "model":
            await self.set_session_model(model_id=value, session_id=session_id)
        elif config_id == "mode":
            await self.set_session_mode(mode_id=value, session_id=session_id)
        else:
            return await super().set_config_option(config_id, session_id, value=value, **kwargs)
        sid = self._held_session(session_id)
        info = await (await self._client()).rpc("session.info", session_id=sid)
        fields = await self._session_fields(sid, info, session_id)
        return SetSessionConfigOptionResponse(config_options=fields["config_options"])

    async def _catalog(self, session_id, editor_id):
        client = await self._client()
        try:
            catalog = await client.rpc("commands.catalog", session_id=session_id)
        except GatewayRPCError as exc:
            if str(exc) != "invalid_params":
                raise
            catalog = await client.rpc("commands.catalog")
        if catalog.get("plugin_discovery_error"):
            raise RuntimeError("Hermes could not discover its plugin commands. Retry after fixing the plugin.")
        self._tether_catalogs[session_id] = catalog
        if self._conn:
            await self._conn.session_update(session_id=editor_id, update=AvailableCommandsUpdate(
                session_update="available_commands_update", available_commands=catalog_commands(catalog)))
        return catalog

    async def _after_attach(self, session_id, editor_id):
        await super()._after_attach(session_id, editor_id)
        try:
            await self._catalog(session_id, editor_id)
        except Exception:
            # Static ACP commands remain usable; the next prompt refreshes discovery.
            pass

    async def _run_slash(self, held_id, session_id, text):
        stripped = text.strip()
        if not stripped.startswith("/"):
            return await super()._run_slash(held_id, session_id, text)
        previous = {c.name for c in catalog_commands(self._tether_catalogs.get(session_id, {}))}
        token = stripped.split(None, 1)[0] if stripped else ""
        name = token[1:] if token.startswith("/") else ""
        try:
            catalog = await self._catalog(session_id, held_id)
        except Exception:
            # A first word with another "/" is a path, not a command, so the message still reaches
            # Hermes; /new is Tether's fresh-context command and never depends on discovery.
            if _slash_command(stripped) is not None or "/" in name or name.lower() == "new":
                return await super()._run_slash(held_id, session_id, text)
            raise
        canon = (catalog.get("canon") or {}).get("/" + name.lower(), "/" + name)
        known = {c.name for c in catalog_commands(catalog)}
        if name in previous and name not in known:
            if self._conn:
                await self._conn.session_update(session_id=held_id, update=acp.update_agent_message_text(f"/{name} is no longer available. Nothing was run.\n"))
            return True, None
        if name and "/" not in name and _slash_command(stripped) is None and canon.lstrip("/") in known:
            from acp_adapter.gateway_commands import _forward, CommandRefused
            arg = stripped.split(None, 1)[1] if len(stripped.split(None, 1)) == 2 else ""
            try:
                reply, prompt = await _forward(self, await self._client(), session_id, canon.lstrip("/"), arg)
            except CommandRefused as exc:
                reply, prompt = str(exc), None
            if prompt is not None:
                return False, prompt
            if self._conn:
                await self._conn.session_update(session_id=held_id, update=acp.update_agent_message_text(reply + "\n"))
            return True, None
        result = await super()._run_slash(held_id, session_id, text)
        try:
            await self._catalog(self._aliases.get(held_id, session_id), held_id)
        except Exception:
            pass  # Discovery cannot turn a successfully executed command into a failed prompt.
        return result


async def serve():
    agent = TetherHermesAgent()
    try:
        await acp.run_agent(agent, use_unstable_protocol=True)
    finally:
        await agent.aclose()


if __name__ == "__main__":
    _setup_logging()
    _load_env()
    if "--check" in sys.argv:
        print("hermes=ok")
    else:
        asyncio.run(serve())
