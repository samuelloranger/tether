import SwiftUI

struct ChatBranchSheet: View {
  let point: ChatBranchPoint
  let sourceTitle: String
  let onCreate: (String, String) async -> String?
  @Environment(\.dismiss) private var dismiss
  @State private var title = ""
  @State private var prompt = ""
  @State private var creating = false
  @State private var failure: String?

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Text("Try another approach in a new chat. The original conversation stays available.")
            .foregroundStyle(TetherColors.textSecondary)
          Label("Before your selected message", systemImage: "arrow.triangle.branch")
          Text(sourceTitle).font(.caption).foregroundStyle(TetherColors.textSecondary)
        }
        Section("New chat name") {
          TextField("Name", text: $title).accessibilityIdentifier("chatBranchTitle")
        }
        Section("Edit your prompt") {
          TextEditor(text: $prompt).frame(minHeight: 120).accessibilityIdentifier("chatBranchPrompt")
        }
        Section("Carry over context") {
          Label("Copy earlier messages", systemImage: "doc.on.doc")
          Text("Starts a new agent session with earlier conversation text. This creates a fresh agent session, not a native session fork. Files stay as they are.")
            .font(.caption).foregroundStyle(TetherColors.textSecondary)
        }
        if let error = point.failure ?? failure { Text(error).foregroundStyle(TetherColors.warning) }
      }
      .scrollContentBackground(.hidden).background(TetherColors.background)
      .navigationTitle("Branch conversation").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(creating) }
        ToolbarItem(placement: .confirmationAction) {
          Button(creating ? "Creating…" : "Create branch") {
            creating = true
            Task {
              failure = await onCreate(title.trimmingCharacters(in: .whitespacesAndNewlines), prompt)
              creating = false
              if failure == nil { dismiss() }
            }
          }
          .disabled(creating || point.failure != nil || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .accessibilityIdentifier("chatBranchCreate")
        }
      }
    }
    .onAppear { title = sourceTitle + " · alternative"; prompt = point.prompt }
    .interactiveDismissDisabled(creating)
    .tint(TetherColors.accent)
  }
}

struct ChatPlanUsageView: View {
  let usage: ChatPlanUsage
  let loading: Bool
  let host: String
  @Environment(\.dynamicTypeSize) private var size

  var body: some View {
    TimelineView(.periodic(from: .now, by: 60)) { timeline in
      VStack(alignment: .leading, spacing: 8) {
        Text("Plan usage · \(host) accounts").font(.caption2).foregroundStyle(TetherColors.textSecondary)
        if size.isAccessibilitySize {
          provider("Claude", agent: ChatAgents.claude, usage: usage.claude, now: timeline.date)
          provider("Codex", agent: ChatAgents.codex, usage: usage.codex, now: timeline.date)
        } else {
          HStack(alignment: .top, spacing: 16) {
            provider("Claude", agent: ChatAgents.claude, usage: usage.claude, now: timeline.date)
            provider("Codex", agent: ChatAgents.codex, usage: usage.codex, now: timeline.date)
          }
        }
      }
    }
    .padding(.horizontal, 16).padding(.vertical, 12)
    .accessibilityIdentifier("drawerPlanUsage")
  }

  private func provider(_ name: String, agent: ChatAgentProfile, usage: ChatProviderUsage?, now: Date) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 5) {
        ChatAgentMark(agent: agent, size: 12)
        Text(name).font(.caption.weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
      }
      window("5 hours", usage?.fiveHour, now: now)
      window("Weekly", usage?.weekly, now: now)
      Text(loading && usage == nil ? "Updating…" : usage?.freshness(now: now) ?? "Usage unavailable")
        .font(.caption2).foregroundStyle(TetherColors.textFaint).fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func window(_ label: String, _ raw: ChatQuotaWindow?, now: Date) -> some View {
    let window = raw.flatMap { $0.valid ? $0 : nil }
    return VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .firstTextBaseline, spacing: 3) {
        Text(label).foregroundStyle(TetherColors.textSecondary)
        Spacer(minLength: 1)
        Text(window.map { "\(Int($0.usedPercent.rounded()))% used" } ?? "—")
          .foregroundStyle(TetherColors.textPrimary).monospacedDigit()
      }
      .font(.caption2)
      GeometryReader { proxy in
        Capsule().fill(TetherColors.surfaceRaised)
          .overlay(alignment: .leading) {
            if let window {
              Capsule().fill(window.usedPercent >= 80 ? TetherColors.warning : TetherColors.accent)
                .frame(width: proxy.size.width * window.fraction)
            }
          }
      }.frame(height: 3).accessibilityHidden(true)
      Text(window?.resetLabel(now: now) ?? (loading ? "Updating…" : "Not available"))
        .font(.caption2).foregroundStyle(TetherColors.textFaint)
    }
    .accessibilityElement(children: .combine)
  }
}
