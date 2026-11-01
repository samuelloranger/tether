import SwiftUI

struct ChatCardActions {
  var enabled = false
  var pending: (String) -> Bool = { _ in false }
  var send: (ChatCard, String, ChatCard.Container?) -> Bool = { _, _, _ in false }
}

private struct ChatCardActionsKey: EnvironmentKey {
  static let defaultValue = ChatCardActions()
}

extension EnvironmentValues {
  var chatCardActions: ChatCardActions {
    get { self[ChatCardActionsKey.self] }
    set { self[ChatCardActionsKey.self] = newValue }
  }
}

struct ChatCardView: View {
  let card: ChatCard
  @Environment(\.chatCardActions) private var actions
  @State private var expandedContainers: Set<String> = []
  private var requested: Bool { actions.pending(card.id) }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(card.title, systemImage: symbol).font(.subheadline.weight(.semibold))
        .foregroundStyle(TetherColors.textPrimary)
      if !card.supported {
        Text(card.fallback).font(.subheadline).textSelection(.enabled)
      } else if card.kind == "weather" {
        weather
      } else if card.kind == "docker" {
        docker
      } else {
        if let image = card.image { ChatImageView(ref: image).accessibilityLabel(card.payload.alt ?? card.title) }
        else { ChatImagePlaceholder() }
        Text(card.payload.alt ?? card.fallback).font(.caption).foregroundStyle(TetherColors.textSecondary)
      }
      VStack(alignment: .leading, spacing: 3) {
        Text(card.source).font(.caption)
        Text("Fetched \(card.fetchedAt)").font(.caption2)
      }
      .foregroundStyle(TetherColors.textFaint).textSelection(.enabled)
      if card.supported && card.kind != "image" {
        action("Refresh", request: "refresh")
      }
      if requested {
        Label("Requested · see conversation", systemImage: "clock")
          .font(.caption).foregroundStyle(TetherColors.textSecondary)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(TetherColors.border, lineWidth: 0.5))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("chatCard-\(card.kind)")
    .onAppear {
      #if DEBUG
      if ProcessInfo.processInfo.environment["TETHER_DEBUG_CHAT_FIXTURE"] == "card-docker", let first = card.payload.containers?.first {
        expandedContainers.insert(first.id)
      }
      #endif
    }
  }

  private var symbol: String {
    switch card.kind { case "weather": "cloud.sun"; case "docker": "shippingbox"; case "image": "photo"; default: "doc.text" }
  }

  private func temperature(_ value: Double?) -> String {
    value.map { "\($0.formatted(.number.precision(.fractionLength(0...1))))°\(card.payload.unit ?? "C")" } ?? "Unavailable"
  }

  private var weather: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(card.payload.location ?? "").font(.subheadline).foregroundStyle(TetherColors.textSecondary)
      Text(temperature(card.payload.temperature)).font(.title.weight(.medium)).monospacedDigit()
      Text(card.payload.conditions ?? "").font(.subheadline)
      if let feels = card.payload.feelsLike {
        Text("Feels like \(temperature(feels))").font(.caption).foregroundStyle(TetherColors.textSecondary)
      }
      if let hours = card.payload.hourly, !hours.isEmpty {
        ScrollView(.horizontal) {
          HStack(alignment: .top, spacing: 20) {
            ForEach(Array(hours.enumerated()), id: \.offset) { _, hour in
              VStack(alignment: .leading, spacing: 6) {
                Text(hourLabel(hour.time)).font(.caption).foregroundStyle(TetherColors.textSecondary)
                Text(temperature(hour.temperature)).font(.subheadline.weight(.medium)).monospacedDigit()
                Text(hour.conditions).font(.caption).fixedSize(horizontal: false, vertical: true)
                if let rain = hour.precipitation {
                  Text("\(rain.formatted())% rain").font(.caption).foregroundStyle(TetherColors.textSecondary)
                }
              }.frame(width: 100, alignment: .leading)
            }
          }.padding(.vertical, 4)
        }
        Text(card.payload.timeZone ?? "").font(.caption2).foregroundStyle(TetherColors.textFaint)
      }
    }
  }

  private func hourLabel(_ stamp: String) -> String {
    let parser = ISO8601DateFormatter()
    guard let date = parser.date(from: stamp) else { return stamp }
    let formatter = DateFormatter()
    formatter.timeZone = card.payload.timeZone.flatMap(TimeZone.init(identifier:))
    formatter.dateFormat = "EEE h a"
    return formatter.string(from: date)
  }

  private var docker: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(card.payload.host ?? "").font(.subheadline).textSelection(.enabled)
      let rows = card.payload.containers ?? []
      Text("\(rows.count) listed · \(rows.filter { $0.health == "healthy" }.count) healthy")
        .font(.caption).foregroundStyle(TetherColors.textSecondary)
      if rows.isEmpty { Text("No containers").font(.subheadline) }
      ForEach(rows) { container in
        Divider().overlay(TetherColors.border)
        DisclosureGroup(isExpanded: Binding(get: { expandedContainers.contains(container.id) }, set: { if $0 { expandedContainers.insert(container.id) } else { expandedContainers.remove(container.id) } })) {
          VStack(alignment: .leading, spacing: 8) {
            Text(container.id).font(.caption.monospaced()).textSelection(.enabled)
            Text("CPU: \(container.cpuPercent.map { $0.formatted() + "%" } ?? "Unavailable")")
            Text("Memory: \(container.memoryBytes.map { ByteCountFormatter.string(fromByteCount: Int64(min($0, Double(Int64.max / 2))), countStyle: .memory) } ?? "Unavailable")")
            if let detail = container.detail { Text(detail).textSelection(.enabled) }
            ViewThatFits(in: .horizontal) {
              HStack { containerActions(container) }
              VStack(alignment: .leading) { containerActions(container) }
            }
          }.frame(maxWidth: .infinity, alignment: .leading).font(.caption).padding(.top, 8)
        } label: {
          VStack(alignment: .leading, spacing: 3) {
            Text(container.name).font(.subheadline.weight(.medium)).foregroundStyle(TetherColors.textPrimary)
            Text("\(container.state) · \(container.health ?? "Health unavailable")")
              .font(.caption).foregroundStyle(container.health == "unhealthy" ? TetherColors.warning : TetherColors.textSecondary)
          }
        }.tint(TetherColors.textSecondary)
      }
      if let total = card.payload.total, total > rows.count {
        Text("Showing \(rows.count) of \(total) containers").font(.caption).foregroundStyle(TetherColors.textSecondary)
      }
    }
  }

  @ViewBuilder private func containerActions(_ container: ChatCard.Container) -> some View {
    action("Show logs", request: "logs", container: container)
    action("Request restart", request: "restart", container: container)
  }

  @ViewBuilder private func action(_ title: String, request: String, container: ChatCard.Container? = nil) -> some View {
    if card.kind == "docker" {
      Button {
        guard !requested, actions.enabled else { return }
        _ = actions.send(card, request, container)
      } label: {
        Text(title).font(.caption.weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
          .padding(.horizontal, 10).padding(.vertical, 6)
          .background(TetherColors.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
          .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
      }
      .buttonStyle(.plain).disabled(!actions.enabled || requested)
    } else {
      Button {
        guard !requested, actions.enabled else { return }
        _ = actions.send(card, request, container)
      } label: {
        Text(title).font(.caption.weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
          .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
      }
      .buttonStyle(.bordered)
      .tint(TetherColors.accent).disabled(!actions.enabled || requested)
    }
  }
}
