import SwiftUI

/// Mode, model and the other session settings, the session's numbers, and the two quick commands.
struct ChatControlsSheet: View {
  @Bindable var model: ChatSessionModel
  @Environment(\.dismiss) private var dismiss
  @State private var confirmingBypass: (option: String, value: String)?

  private static let bypass = "bypassPermissions"

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        header
        if model.readOnly {
          Label("Started on another device. Read only.", systemImage: "eye")
            .font(.footnote).foregroundStyle(TetherColors.textSecondary)
        }
        ForEach(model.state.configOptions) { option in optionSection(option) }
        sessionSection
        commandsSection
      }
      .padding(.horizontal, 16).padding(.top, 20).padding(.bottom, 24)
    }
    .background(TetherColors.background)
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .presentationBackground(TetherColors.background)
    .confirmationDialog("Bypass permissions", isPresented: Binding(
      get: { confirmingBypass != nil }, set: { if !$0 { confirmingBypass = nil } }
    ), titleVisibility: .visible) {
      Button("Bypass permissions", role: .destructive) {
        if let pending = confirmingBypass { model.setOption(id: pending.option, value: pending.value) }
        confirmingBypass = nil
      }
      Button("Cancel", role: .cancel) { confirmingBypass = nil }
    } message: {
      Text("Bypass permissions: the agent runs every tool without asking.")
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(model.title).font(.headline).foregroundStyle(TetherColors.textPrimary).lineLimit(1)
      Text(model.cwd).font(.caption.monospaced()).foregroundStyle(TetherColors.textFaint)
        .lineLimit(1).truncationMode(.head)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(model.title), \(model.cwd)")
  }

  // MARK: Options

  private func optionSection(_ option: ACPConfigOption) -> some View {
    let change = model.optionChanges[option.id]
    return VStack(alignment: .leading, spacing: 6) {
      sectionTitle(option.name)
      VStack(spacing: 0) {
        ForEach(Array(option.choices.enumerated()), id: \.element.value) { index, choice in
          if index > 0 { Divider().overlay(TetherColors.border).padding(.leading, 12) }
          choiceRow(option, choice, change: change)
        }
      }
      .sheetGroup
      if case let .failed(_, message)? = change {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(message).font(.caption).foregroundStyle(TetherColors.danger)
          Spacer(minLength: 0)
          Button { model.dismissOptionFailure(id: option.id) } label: {
            Image(systemName: "xmark").font(.caption2.weight(.semibold)).hitSlop(vertical: 12, horizontal: 12)
          }
          .buttonStyle(.plain)
          .foregroundStyle(TetherColors.textFaint)
          .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, 4)
      }
    }
  }

  private func choiceRow(_ option: ACPConfigOption, _ choice: ACPConfigChoice, change: ChatSessionModel.OptionChange?) -> some View {
    let selected = option.currentValue == choice.value
    var pending = false
    if case let .pending(value)? = change { pending = value == choice.value }
    return Button {
      if option.id == "mode", choice.value == Self.bypass, !selected {
        confirmingBypass = (option.id, choice.value)
      } else {
        model.setOption(id: option.id, value: choice.value)
      }
    } label: {
      HStack(spacing: 10) {
        VStack(alignment: .leading, spacing: 1) {
          Text(choice.name).font(.subheadline).foregroundStyle(TetherColors.textPrimary).lineLimit(1)
          if !choice.description.isEmpty {
            Text(choice.description).font(.caption).foregroundStyle(TetherColors.textSecondary).lineLimit(1)
          }
        }
        Spacer(minLength: 8)
        if pending {
          ProgressView().controlSize(.small)
        } else if selected {
          Image(systemName: "checkmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(TetherColors.accent)
        }
      }
      .padding(.horizontal, 12).padding(.vertical, 6)
      .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!model.canInteract)
    .opacity(model.canInteract ? 1 : 0.55)
    .accessibilityLabel("\(choice.name)\(choice.description.isEmpty ? "" : ", \(choice.description)")")
    .accessibilityValue(pending ? "Changing" : selected ? "Selected" : "")
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  // MARK: Session

  private var sessionSection: some View {
    let state = model.state
    return VStack(alignment: .leading, spacing: 6) {
      sectionTitle("Session")
      VStack(spacing: 0) {
        if let fraction = ChatFormat.contextFraction(used: state.contextUsed, size: state.contextSize) {
          VStack(alignment: .leading, spacing: 6) {
            HStack {
              Text("Context").font(.subheadline).foregroundStyle(TetherColors.textPrimary)
              Spacer(minLength: 8)
              Text(ChatFormat.contextSummary(used: state.contextUsed, size: state.contextSize) ?? "")
                .font(.caption.monospacedDigit()).foregroundStyle(TetherColors.textSecondary)
            }
            Capsule().fill(TetherColors.border).frame(height: 4)
              .overlay(alignment: .leading) {
                GeometryReader { proxy in
                  Capsule().fill(TetherColors.accent).frame(width: max(4, proxy.size.width * fraction))
                }
              }
          }
          .padding(.horizontal, 12).padding(.vertical, 10)
          .accessibilityElement(children: .ignore)
          .accessibilityLabel("Context used")
          .accessibilityValue(ChatFormat.contextSummary(used: state.contextUsed, size: state.contextSize) ?? "")
          Divider().overlay(TetherColors.border).padding(.leading, 12)
        }
        if let cost = state.cost {
          infoRow("Cost", ChatFormat.cost(cost))
          Divider().overlay(TetherColors.border).padding(.leading, 12)
        }
        if let id = state.modelId {
          infoRow("Model id", id, mono: true)
          Divider().overlay(TetherColors.border).padding(.leading, 12)
        }
        infoRow("Folder", model.cwd, mono: true, head: true)
        Divider().overlay(TetherColors.border).padding(.leading, 12)
        infoRow("Connection", connectionText, dot: connectionColor)
      }
      .sheetGroup
    }
  }

  private var connectionText: String {
    switch model.link.phase {
    case .live: "Live"
    case .connecting: "Connecting"
    case .catchingUp: "Catching up"
    case .lost: "Disconnected"
    case .ended: "Ended"
    }
  }

  private var connectionColor: Color {
    switch model.link.phase {
    case .live: TetherColors.success
    case .connecting, .catchingUp: TetherColors.warning
    case .lost: TetherColors.danger
    case .ended: TetherColors.textFaint
    }
  }

  private func infoRow(_ label: String, _ value: String, mono: Bool = false, head: Bool = false, dot: Color? = nil) -> some View {
    HStack(spacing: 12) {
      Text(label).font(.subheadline).foregroundStyle(TetherColors.textPrimary)
      Spacer(minLength: 8)
      if let dot { Circle().fill(dot).frame(width: 6, height: 6) }
      Text(value)
        .font(mono ? .caption.monospaced() : .subheadline)
        .foregroundStyle(TetherColors.textSecondary)
        .lineLimit(1).truncationMode(head ? .head : .tail)
        .textSelection(.enabled)
    }
    .padding(.horizontal, 12)
    .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
    .accessibilityElement(children: .combine)
  }

  // MARK: Commands

  @ViewBuilder private var commandsSection: some View {
    let offered = ChatQuickCommand.allCases.filter { $0.isOffered(by: model.state.commands) }
    if !offered.isEmpty {
      VStack(alignment: .leading, spacing: 6) {
        sectionTitle("Commands")
        VStack(spacing: 0) {
          ForEach(Array(offered.enumerated()), id: \.element) { index, command in
            if index > 0 { Divider().overlay(TetherColors.border).padding(.leading, 12) }
            Button {
              if model.send(command.text) { dismiss() }
            } label: {
              HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                  Text(command.title).font(.subheadline).foregroundStyle(TetherColors.textPrimary)
                  Text(command.detail).font(.caption).foregroundStyle(TetherColors.textSecondary).lineLimit(1)
                }
                Spacer(minLength: 8)
                Text(command.text).font(.caption.monospaced()).foregroundStyle(TetherColors.textFaint)
              }
              .padding(.horizontal, 12).padding(.vertical, 6)
              .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!model.canSend || model.isWorking)
            .opacity(model.canSend && !model.isWorking ? 1 : 0.55)
            .accessibilityLabel("\(command.title), \(command.detail)")
          }
        }
        .sheetGroup
      }
    }
  }

  private func sectionTitle(_ text: String) -> some View {
    Text(text.uppercased()).font(.caption2.weight(.semibold)).tracking(0.6)
      .foregroundStyle(TetherColors.textFaint).padding(.horizontal, 4)
      .accessibilityAddTraits(.isHeader)
  }
}

extension View {
  fileprivate var sheetGroup: some View {
    background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 12))
      .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(TetherColors.border, lineWidth: 0.5))
  }
}
