import SwiftUI

struct ChatWorkflowSelection: Identifiable, Equatable {
  var id: String
}

/// The background workflows still running, above the composer; a tap opens the run's phases.
struct ChatWorkflowStrip: View {
  let runs: [ChatWorkflowRun]
  let open: (ChatWorkflowRun) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(runs.enumerated()), id: \.element.id) { index, run in
        if index > 0 { Rectangle().fill(TetherColors.border).frame(height: 0.5) }
        Button { open(run) } label: {
          HStack(spacing: 6) {
            ProgressView().controlSize(.mini).tint(TetherColors.accent)
            Text(ChatWorkflowText.strip(run)).font(.caption.monospaced()).foregroundStyle(TetherColors.textSecondary)
              .lineLimit(1).truncationMode(.tail)
              .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(TetherColors.textFaint)
          }
          .padding(.horizontal, 10).frame(minHeight: 30)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Workflow: \(ChatWorkflowText.strip(run))")
        .accessibilityHint("Shows the phases and agents")
      }
    }
    .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(TetherColors.border, lineWidth: 1))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("chatWorkflowStrip")
  }
}

/// One run: its phases with each agent's state and time, and the summary once it has ended.
struct ChatWorkflowSheet: View {
  @Bindable var model: ChatSessionModel
  let callId: String
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Group {
        if let run = model.workflowTracker.run(forCall: callId) {
          TimelineView(.periodic(from: .now, by: 1)) { context in content(run, now: context.date) }
        } else {
          Text("This workflow is no longer listed on the host.")
            .font(.footnote).foregroundStyle(TetherColors.textSecondary).padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      .background(TetherColors.background)
      .navigationTitle(model.workflowTracker.run(forCall: callId)?.title ?? "Workflow")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .presentationBackground(TetherColors.background)
    .accessibilityIdentifier("chatWorkflowSheet")
  }

  private func content(_ run: ChatWorkflowRun, now: Date) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        header(run, now: now)
        ForEach(Array(run.phases.enumerated()), id: \.offset) { _, phase in
          phaseSection(phase, now: now)
        }
        if let summary = run.summary, !run.isRunning {
          Text(summary).font(.footnote).foregroundStyle(TetherColors.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(TetherColors.border, lineWidth: 1))
            .accessibilityIdentifier("chatWorkflowSummary")
        }
      }
      .padding(.horizontal, 16).padding(.vertical, 12)
    }
  }

  private func header(_ run: ChatWorkflowRun, now: Date) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        runGlyph(run)
        Text(ChatWorkflowText.statusWord(run)).font(.footnote.weight(.semibold))
          .foregroundStyle(run.isRunning ? TetherColors.accent : TetherColors.textSecondary)
        Text("\(run.doneCount)/\(run.totalCount) agents").font(.footnote.monospacedDigit())
          .foregroundStyle(TetherColors.textFaint)
        Spacer(minLength: 0)
        if let elapsed = ChatWorkflowText.elapsed(run, now: now) {
          Text(elapsed).font(.footnote.monospacedDigit()).foregroundStyle(TetherColors.textFaint)
        }
      }
      if let description = run.description {
        Text(description).font(.caption).foregroundStyle(TetherColors.textFaint).lineLimit(3)
      }
    }
  }

  @ViewBuilder private func runGlyph(_ run: ChatWorkflowRun) -> some View {
    switch run.status {
    case .running: ProgressView().controlSize(.mini).tint(TetherColors.accent)
    case .completed: Image(systemName: "checkmark").font(.caption2.weight(.bold)).foregroundStyle(TetherColors.success)
    case .ended: Image(systemName: "xmark").font(.caption2.weight(.bold)).foregroundStyle(TetherColors.danger)
    }
  }

  private func phaseSection(_ phase: ChatWorkflowRun.Phase, now: Date) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(phase.title.isEmpty ? "Agents" : phase.title).font(.caption.weight(.semibold))
        .foregroundStyle(TetherColors.textSecondary)
        .padding(.bottom, 6)
      VStack(spacing: 0) {
        if phase.agents.isEmpty {
          Text("Not started").font(.footnote).foregroundStyle(TetherColors.textFaint)
            .padding(.horizontal, 10).frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
        }
        ForEach(Array(phase.agents.enumerated()), id: \.offset) { index, agent in
          if index > 0 { Rectangle().fill(TetherColors.border).frame(height: 0.5).padding(.leading, 30) }
          agentRow(agent, now: now)
        }
      }
      .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).stroke(TetherColors.border, lineWidth: 1))
    }
    .accessibilityElement(children: .contain)
  }

  private func agentRow(_ agent: ChatWorkflowRun.Agent, now: Date) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Group {
        if agent.isDone {
          Image(systemName: "checkmark").font(.caption2.weight(.bold)).foregroundStyle(TetherColors.success)
        } else {
          ProgressView().controlSize(.mini).tint(TetherColors.accent)
        }
      }
      .frame(width: 14)
      VStack(alignment: .leading, spacing: 1) {
        Text(agent.label).font(.footnote).foregroundStyle(TetherColors.textPrimary).lineLimit(1)
        if let activity = agent.activity, !agent.isDone {
          Text(activity).font(.caption2.monospaced()).foregroundStyle(TetherColors.textFaint)
            .lineLimit(1).truncationMode(.tail)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if let elapsed = ChatWorkflowText.elapsed(agent, now: now) {
        Text(elapsed).font(.caption.monospacedDigit()).foregroundStyle(TetherColors.textFaint)
      }
    }
    .padding(.horizontal, 10).padding(.vertical, 7)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(agent.label), \(agent.isDone ? "done" : "running")")
  }
}
