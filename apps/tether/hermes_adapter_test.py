"""Run with Hermes's virtualenv: python -m unittest hermes_adapter_test."""
import asyncio
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from acp.exceptions import RequestError
from acp.schema import NewSessionResponse
from acp_adapter.gateway_commands import CommandRefused
from acp_adapter.gateway_server import GatewayACPAgent
from hermes_cli.gateway_client import GatewayRPCError
from hermes_adapter import TetherHermesAgent, catalog_commands


class HermesAdapterTests(unittest.IsolatedAsyncioTestCase):
    def viewer(self):
        agent = TetherHermesAgent()
        agent._conn = SimpleNamespace(session_update=AsyncMock())
        return agent

    def test_catalog_keeps_dynamic_skills_and_argument_hints(self):
        commands = catalog_commands({"pairs": [["/plugin", "Plugin"], ["/skill", "Skill"], ["/bad/name", "Bad"], None],
                                    "commands": {"/plugin": {"argument_mode": "text"}}, "skills": {"/skill": {}}})
        by_name = {c.name: c for c in commands}
        self.assertEqual(set(by_name), {"plugin", "skill", "new"})
        self.assertIsNotNone(by_name["skill"].input)
        self.assertIsNotNone(by_name["plugin"].input)

    async def test_plain_chat_does_not_depend_on_plugin_discovery(self):
        agent = self.viewer()
        agent._catalog = AsyncMock(side_effect=RuntimeError("plugin failed"))
        with patch.object(GatewayACPAgent, "_run_slash", AsyncMock(return_value=(False, "hello"))):
            self.assertEqual(await agent._run_slash("held", "sid", "hello"), (False, "hello"))
        agent._catalog.assert_not_awaited()

    async def test_a_message_starting_with_a_path_survives_failed_discovery(self):
        agent = self.viewer()
        agent._catalog = AsyncMock(side_effect=RuntimeError("plugin failed"))
        text = "/var/log/app is full"
        with patch.object(GatewayACPAgent, "_run_slash", AsyncMock(return_value=(False, text))) as parent:
            self.assertEqual(await agent._run_slash("held", "sid", text), (False, text))
            # Never discovered, still command-shaped: refused rather than sent to the model as text.
            with self.assertRaises(RuntimeError):
                await agent._run_slash("held", "sid", "/custom-plugin arg")
            parent.assert_awaited_once()

    async def test_refresh_failure_does_not_fail_a_successful_command(self):
        agent = self.viewer()
        agent._catalog = AsyncMock(side_effect=[{"pairs": [["/help", "Help"]]}, RuntimeError("refresh failed")])
        with patch.object(GatewayACPAgent, "_run_slash", AsyncMock(return_value=(True, None))):
            self.assertEqual(await agent._run_slash("held", "sid", "/help"), (True, None))

    async def test_dynamic_command_refusals_are_replies_not_model_prompts(self):
        agent = self.viewer()
        agent._catalog = AsyncMock(return_value={"pairs": [["/custom-plugin", "Plugin"]]})
        agent._client = AsyncMock(return_value=object())
        with patch("acp_adapter.gateway_commands._forward", AsyncMock(side_effect=CommandRefused("Unavailable here"))):
            self.assertEqual(await agent._run_slash("held", "sid", "/custom-plugin"), (True, None))
        agent._conn.session_update.assert_awaited_once()

    async def test_concurrent_viewers_create_one_persistent_session(self):
        with tempfile.TemporaryDirectory() as root:
            first, second = self.viewer(), self.viewer()
            for agent in (first, second):
                agent._tether_pointer = Path(root) / "conversation.json"
                agent._resume = AsyncMock(return_value={})
            created = []
            async def create(*args, **kwargs):
                created.append("session-" + str(len(created) + 1))
                await asyncio.sleep(0.05)
                return NewSessionResponse(session_id=created[-1])
            with patch.object(GatewayACPAgent, "new_session", create):
                results = await asyncio.gather(first.new_session("/work"), second.new_session("/work"))
            self.assertEqual(created, ["session-1"])
            self.assertEqual([r.session_id for r in results], ["session-1", "session-1"])
            self.assertEqual(first._tether_pointer.stat().st_mode & 0o777, 0o600)

    async def test_corrupt_pointer_never_silently_starts_another_conversation(self):
        with tempfile.TemporaryDirectory() as root:
            agent = self.viewer()
            agent._tether_pointer = Path(root) / "conversation.json"
            agent._tether_pointer.write_text("broken")
            with patch.object(GatewayACPAgent, "new_session", AsyncMock()) as create:
                with self.assertRaisesRegex(RequestError, "unreadable"):
                    await agent.new_session("/work")
                create.assert_not_awaited()

    async def test_a_conversation_hermes_lost_says_how_to_start_over(self):
        with tempfile.TemporaryDirectory() as root:
            agent = self.viewer()
            agent._tether_pointer = Path(root) / "conversation.json"
            agent._tether_pointer.write_text(json.dumps({"session_id": "gone"}))
            agent._resume = AsyncMock(side_effect=GatewayRPCError("not_found"))
            with patch.object(GatewayACPAgent, "new_session", AsyncMock()) as create:
                with self.assertRaisesRegex(RequestError, "Delete .*conversation.json"):
                    await agent.new_session("/work")
                create.assert_not_awaited()
            self.assertTrue(agent._tether_pointer.exists())

    async def test_other_resume_failures_are_not_reported_as_a_lost_conversation(self):
        with tempfile.TemporaryDirectory() as root:
            agent = self.viewer()
            agent._tether_pointer = Path(root) / "conversation.json"
            agent._tether_pointer.write_text(json.dumps({"session_id": "kept"}))
            agent._resume = AsyncMock(side_effect=GatewayRPCError("busy"))
            with self.assertRaises(GatewayRPCError):
                await agent.new_session("/work")

    def test_docker_workspace_does_not_use_the_ssh_host_path(self):
        agent = self.viewer()
        with patch.dict(os.environ, {"HOME": "/opt/data", "TERMINAL_CWD": "/opt/data/workspace"}):
            self.assertEqual(agent._workspace("/home/host/not-in-container"), "/opt/data/workspace")


if __name__ == "__main__":
    unittest.main()
