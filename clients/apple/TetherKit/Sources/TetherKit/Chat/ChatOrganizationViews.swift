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
  let onRefresh: () -> Void
  @Environment(\.dynamicTypeSize) private var size
  @State private var selected: String?
  @ScaledMetric(relativeTo: .caption2) private var quotaWidth = 48.0

  var body: some View {
    TimelineView(.periodic(from: .now, by: 60)) { timeline in
      VStack(alignment: .leading, spacing: 2) {
        HStack {
          Text("Subscriptions · used").font(.caption2).foregroundStyle(TetherColors.textSecondary)
          Spacer(minLength: 0)
          Button(action: onRefresh) {
            Image(systemName: "arrow.clockwise").font(.caption).frame(minWidth: 44, minHeight: 44)
          }
          .buttonStyle(.plain).foregroundStyle(TetherColors.textSecondary)
          .disabled(loading).accessibilityLabel("Refresh subscription usage")
        }
        ForEach(usage.subscriptions) { subscription in
          Button { selected = subscription.id } label: {
            row(subscription).frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("quota-" + subscription.id)
          .accessibilityHint("Show quota limits and reset times")
          .popover(isPresented: Binding(get: { selected == subscription.id }, set: { if !$0 { selected = nil } })) {
            ChatQuotaDetailView(subscription: subscription, host: host, onClose: { selected = nil })
              .presentationCompactAdaptation(.sheet)
              .presentationDetents([.medium, .large])
          }
        }
        if let provider = usage.subscriptions.first(where: { $0.usage?.isStale(now: timeline.date) == true }) ?? usage.subscriptions.first,
           let reading = provider.usage {
          Text(reading.freshness(now: timeline.date) + (reading.isStale(now: timeline.date) ? " · stale" : ""))
            .font(.caption2).foregroundStyle(reading.isStale(now: timeline.date) ? TetherColors.warning : TetherColors.textFaint)
        }
      }
    }
    .padding(.horizontal, 16).padding(.vertical, 6)
    .accessibilityIdentifier("drawerPlanUsage")
    #if DEBUG
    .onAppear {
      if let id = ProcessInfo.processInfo.environment["TETHER_DEBUG_QUOTA"], usage.subscriptions.contains(where: { $0.id == id }) {
        selected = id
      }
    }
    #endif
  }

  private func row(_ subscription: ChatUsageSubscription) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 7) {
        ChatAgentMark(agent: subscription.agent, size: 14)
        Text(subscription.name).font(.caption.weight(.medium)).foregroundStyle(TetherColors.textPrimary)
        Spacer(minLength: 2)
        if !size.isAccessibilitySize { compactWindows(subscription.usage) }
        Image(systemName: "chevron.right").font(.caption2).foregroundStyle(TetherColors.textFaint)
      }
      if size.isAccessibilitySize { compactWindows(subscription.usage) }
    }
  }

  @ViewBuilder private func compactWindows(_ reading: ChatProviderUsage?) -> some View {
    if let meter = reading?.monthlyMeter {
      VStack(spacing: 3) {
        HStack(spacing: 3) {
          Text("Month").foregroundStyle(TetherColors.textSecondary)
          Spacer(minLength: 1)
          Text(meter.value).foregroundStyle((meter.percent ?? 0) >= 80 ? TetherColors.warning : TetherColors.textPrimary).monospacedDigit()
        }.font(.caption2)
        if let percent = meter.percent { ChatQuotaBar(fraction: percent / 100, warning: percent >= 80).frame(height: 2) }
      }
      .frame(width: quotaWidth * 2 + 9)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Monthly usage").accessibilityValue(meter.detailValue)
    } else {
      HStack(spacing: 9) {
        compactWindow("5h", reading?.fiveHour)
        compactWindow("wk", reading?.weekly)
      }
    }
  }

  private func compactWindow(_ label: String, _ raw: ChatQuotaWindow?) -> some View {
    let window = raw.flatMap { $0.valid ? $0 : nil }
    return VStack(spacing: 3) {
      HStack(spacing: 2) {
        Text(label).foregroundStyle(TetherColors.textSecondary)
        Spacer(minLength: 1)
        Text(window.map { "\(Int($0.usedPercent.rounded()))%" } ?? "—")
          .foregroundStyle((window?.usedPercent ?? 0) >= 80 ? TetherColors.warning : TetherColors.textPrimary)
          .monospacedDigit()
      }.font(.caption2)
      ChatQuotaBar(fraction: window?.fraction, warning: (window?.usedPercent ?? 0) >= 80).frame(height: 2)
    }
    .frame(width: quotaWidth)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(label == "5h" ? "5 hours" : "Weekly")
    .accessibilityValue(window.map { "\(Int($0.usedPercent.rounded())) percent used" } ?? "Usage unavailable")
  }
}

private struct ChatQuotaBar: View {
  let fraction: Double?
  let warning: Bool
  var body: some View {
    GeometryReader { proxy in
      Capsule().fill(TetherColors.surfaceRaised)
        .overlay(alignment: .leading) {
          if let fraction {
            Capsule().fill(warning ? TetherColors.warning : TetherColors.accent)
              .frame(width: proxy.size.width * fraction)
          }
        }
    }.accessibilityHidden(true)
  }
}

private struct ChatQuotaDetailView: View {
  let subscription: ChatUsageSubscription
  let host: String
  let onClose: () -> Void

  var body: some View {
    TimelineView(.periodic(from: .now, by: 60)) { timeline in
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          HStack(spacing: 9) {
            ChatAgentMark(agent: subscription.agent, size: 20)
            VStack(alignment: .leading, spacing: 3) {
              Text(subscription.id == "opencode" ? "OpenCode Go" : subscription.name)
                .font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
              Text(host + " account").font(.caption2).foregroundStyle(TetherColors.textSecondary)
            }
            Spacer()
            Button(action: onClose) {
              Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44)
            }.buttonStyle(.plain).accessibilityLabel("Close quota details")
          }
          Divider()
          if let reading = subscription.usage {
            if reading.isStale(now: timeline.date) {
              Text("Couldn’t refresh. Showing last known usage.")
                .font(.caption).foregroundStyle(TetherColors.warning)
            }
            if let meter = reading.monthlyMeter {
              VStack(alignment: .leading, spacing: 7) {
                Text(meter.unit == "credits" ? "Monthly AI credits" : "Monthly requests")
                  .foregroundStyle(TetherColors.textSecondary)
                Text(meter.detailValue).foregroundStyle(TetherColors.textPrimary).monospacedDigit()
                if let percent = meter.percent { ChatQuotaBar(fraction: percent / 100, warning: percent >= 80).frame(height: 4) }
                Text(meter.resetLabel(now: timeline.date)).font(.caption2).foregroundStyle(TetherColors.textSecondary)
              }.font(.caption).accessibilityElement(children: .combine)
            } else {
              window("5 hours", reading.fiveHour, now: timeline.date)
              window("Weekly", reading.weekly, now: timeline.date)
              if reading.monthly != nil { window("Monthly", reading.monthly, now: timeline.date) }
            }
            Divider()
            Text(reading.freshness(now: timeline.date)).font(.caption2).foregroundStyle(TetherColors.textSecondary)
          }
        }.padding(16)
      }
    }
    .frame(idealWidth: 310, idealHeight: subscription.usage?.monthly == nil ? 290 : 360)
    .background(TetherColors.surface)
    .tint(TetherColors.accent)
  }

  private func window(_ label: String, _ raw: ChatQuotaWindow?, now: Date) -> some View {
    let window = raw.flatMap { $0.valid ? $0 : nil }
    return VStack(alignment: .leading, spacing: 7) {
      HStack {
        Text(label).foregroundStyle(TetherColors.textSecondary)
        Spacer()
        Text(window.map { "\(Int($0.usedPercent.rounded()))% used" } ?? "—")
          .foregroundStyle((window?.usedPercent ?? 0) >= 80 ? TetherColors.warning : TetherColors.textPrimary)
          .monospacedDigit()
      }.font(.caption)
      ChatQuotaBar(fraction: window?.fraction, warning: (window?.usedPercent ?? 0) >= 80).frame(height: 4)
      Text(window?.resetLabel(now: now) ?? "Usage unavailable").font(.caption2).foregroundStyle(TetherColors.textSecondary)
    }.accessibilityElement(children: .combine)
  }
}
