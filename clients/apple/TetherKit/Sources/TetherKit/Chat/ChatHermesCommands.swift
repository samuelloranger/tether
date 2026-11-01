import SwiftUI

struct HermesCommandsSheet: View {
  @Bindable var model: ChatSessionModel
  @Environment(\.dismiss) private var dismiss
  var onSent: () -> Void = {}
  var initialCommand: ACPCommand?
  @State private var path: [ACPCommand] = []
  @State private var search = ""

  init(model: ChatSessionModel, initialCommand: ACPCommand? = nil, onSent: @escaping () -> Void = {}) {
    self.model = model
    self.onSent = onSent
    self.initialCommand = initialCommand
  }

  var body: some View {
    NavigationStack(path: $path) {
      if let initialCommand {
        HermesCommandModule(model: model, command: initialCommand, close: { onSent(); dismiss() })
          .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      } else {
      List {
        if search.isEmpty {
          Section {
            Label {
              VStack(alignment: .leading, spacing: 4) {
                Text("Your agent. One conversation.").font(.headline)
                Text("Commands come from this Hermes gateway, including its skills and plugins.")
                  .font(.subheadline).foregroundStyle(TetherColors.textSecondary)
              }
            } icon: { ChatAgentMark(agent: ChatAgents.hermes, size: 28) }
            .padding(.vertical, 8)
          }
        }
        Section(search.isEmpty ? "Available commands" : "Matching commands") {
          ForEach(ChatSlash.matches(query: search, commands: model.state.commands, limit: .max)) { command in
            NavigationLink(value: command) {
              VStack(alignment: .leading, spacing: 4) {
                Text("/" + command.name).font(.body.weight(.medium))
                Text(command.description).font(.caption).foregroundStyle(TetherColors.textSecondary)
              }
              .padding(.vertical, 4)
            }
          }
        }
      }
      .scrollContentBackground(.hidden)
      .background(TetherColors.background)
      .searchable(text: $search, prompt: "Find a command or skill")
      .navigationTitle("Hermes commands")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      .navigationDestination(for: ACPCommand.self) { command in
        HermesCommandModule(model: model, command: command, close: { onSent(); dismiss() })
      }
      }
    }
    .tint(TetherColors.accent)
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
  }
}

private struct HermesCommandModule: View {
  @Bindable var model: ChatSessionModel
  let command: ACPCommand
  let close: () -> Void
  @State private var argument = ""
  @State private var confirmNew = false
  @State private var failure: String?
  @State private var initialized = false
  @State private var customModel = ""
  private var module: ChatHermes.Module { ChatHermes.module(for: command) }
  private var modelOption: ACPConfigOption? { model.state.option(id: "model") }

  var body: some View {
    Form {
      Section {
        Text(command.description).foregroundStyle(TetherColors.textSecondary)
        if module == .fresh {
          Label("Fresh context, same Hermes", systemImage: "sparkles")
          Text("Starts a fresh conversation context. Your agent's long-term memory and tools stay available. Earlier messages remain visible in this Tether thread.")
            .font(.subheadline).foregroundStyle(TetherColors.textSecondary)
          Button("Start new conversation") { confirmNew = true }
            .disabled(!model.canSend || model.state.turn == .working)
        } else if module == .model, let option = modelOption, !option.choices.isEmpty {
          Picker("Model", selection: $argument) {
            ForEach(option.choices, id: \.value) { Text($0.name).tag($0.value) }
          }
          .pickerStyle(.navigationLink)
          TextField("Or enter a model name", text: $customModel)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .accessibilityLabel("Custom Hermes model")
          Button("Use this model") {
            if customModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
              model.setOption(id: option.id, value: argument); close()
            } else { run(customModel) }
          }
            .disabled(!model.canInteract || model.state.turn == .working || argument.isEmpty)
          Button("Show current model") { run("") }.disabled(!model.canSend)
        } else {
          if module == .compact {
            Label("Make room to keep going", systemImage: "arrow.down.right.and.arrow.up.left")
            Text("Hermes summarizes the current context so you can continue in the same conversation.")
              .font(.subheadline).foregroundStyle(TetherColors.textSecondary)
          }
          if let hint = command.hint {
            TextField(hint, text: $argument, axis: .vertical)
              .textInputAutocapitalization(.never).autocorrectionDisabled().lineLimit(2...6)
              .accessibilityLabel("Command arguments")
          }
          Button("Run /" + command.name) { run(argument) }
            .disabled(!model.canSend || (module == .compact && model.state.turn == .working))
        }
        if let failure { Text(failure).foregroundStyle(TetherColors.warning) }
      }
      if model.state.turn == .working && (module == .fresh || module == .compact || module == .model) {
        Section { Text("Wait for Hermes to finish, or stop its reply before changing the conversation.").foregroundStyle(TetherColors.textSecondary) }
      }
    }
    .scrollContentBackground(.hidden).background(TetherColors.background)
    .navigationTitle("/" + command.name).navigationBarTitleDisplayMode(.inline)
    .onAppear { if !initialized { argument = module == .model ? modelOption?.currentValue ?? "" : ""; initialized = true } }
    .alert("Start fresh with Hermes?", isPresented: $confirmNew) {
      Button("Cancel", role: .cancel) {}
      Button("Start fresh") { run("") }
    } message: { Text("Hermes clears this conversation's active context. Its long-term memory stays available.") }
  }

  private func run(_ argument: String) {
    if model.send(ChatHermes.commandText(command, argument: argument)) { close() }
    else { failure = "The command couldn't be sent. Reconnect to Hermes and try again." }
  }
}
