import SwiftUI
import UIKit

struct RandomartGridView: View {
  let publicKey: String

  private var field: [[Int]] {
    guard let digest = SSHKeyEncoding.fingerprintDigest(openSSHPublicKey: publicKey) else { return [] }
    return SSHRandomart.field(digest: digest)
  }

  var body: some View {
    GeometryReader { geo in
      let rows = field
      let cols = rows.first?.count ?? 0
      let cell = cols > 0 ? geo.size.width / CGFloat(cols) : 0
      VStack(spacing: 1) {
        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
          HStack(spacing: 1) {
            ForEach(Array(row.enumerated()), id: \.offset) { _, count in
              Rectangle().fill(color(count)).frame(height: cell * 0.82)
            }
          }
        }
      }
    }
    .aspectRatio(17.0 / 9.0, contentMode: .fit)
    .padding(4)
    .background(TetherColors.terminalBackground, in: RoundedRectangle(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(TetherColors.border))
  }

  private func color(_ count: Int) -> Color {
    switch count {
    case 0: return .clear
    case 1...2: return TetherColors.accent.opacity(0.35)
    case 3...5: return TetherColors.accent
    case 6...9: return TetherColors.success
    case 10...14: return TetherColors.warning
    case 15: return TetherColors.accent // start
    default: return TetherColors.danger // end
    }
  }
}

struct MachineCardView: View {
  let profile: SSHHostProfile
  let authLabel: String
  var onOpen: () -> Void

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    // Two monospaced runs side by side wrap into each other at accessibility
    // sizes, so they stack there instead.
    let detailLayout = DynamicTypeLayout.detailLayout(
      for: dynamicTypeSize, stackedSpacing: 2, inlineSpacing: 6)
    return Button(action: onOpen) {
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 10) {
          Circle().fill(TetherColors.heatCool).frame(width: 11, height: 11).opacity(0.6)
          Text(profile.name).font(.headline)
            .foregroundStyle(TetherColors.textPrimary)
          Spacer()
          Text("saved").font(.caption2.weight(.semibold).monospaced())
            .padding(.horizontal, 8).padding(.vertical, 3)
            .foregroundStyle(TetherColors.textFaint)
            .background(Color.white.opacity(0.04), in: Capsule())
            .overlay(Capsule().strokeBorder(TetherColors.border))
        }
        detailLayout {
          Text(verbatim: "\(profile.username)@\(profile.host):\(profile.port)")
          Text(verbatim: "· \(authLabel)").foregroundStyle(TetherColors.textFaint)
        }
        .font(.caption.monospaced())
        .foregroundStyle(TetherColors.textSecondary)
        HStack(spacing: 4) {
          Spacer()
          Text("Open").font(.caption.weight(.semibold))
          Image(systemName: "chevron.right").font(.caption2.weight(.semibold))
        }
        .foregroundStyle(TetherColors.accent)
      }
      .padding(.horizontal, 14).padding(.vertical, 13)
      .tetherCard()
    }
    .buttonStyle(TetherPressStyle())
    .accessibilityIdentifier("homeMachine_\(profile.name)")
    .accessibilityLabel("\(profile.name), \(profile.username) at \(profile.host) port \(profile.port), \(authLabel)")
    .accessibilityHint("Opens a terminal on this machine")
  }
}

struct KeyCardView: View {
  let record: SSHKeyRecord
  let usedBy: [String]

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    let titleLayout = DynamicTypeLayout.detailLayout(
      for: dynamicTypeSize, stackedSpacing: 4, inlineSpacing: 7)
    return HStack(alignment: .top, spacing: 13) {
      // Decorative: at accessibility sizes the name and fingerprint need the width.
      if DynamicTypeLayout.showsDetail(for: dynamicTypeSize) {
        RandomartGridView(publicKey: record.publicKey).frame(width: 78).accessibilityHidden(true)
      }
      VStack(alignment: .leading, spacing: 4) {
        titleLayout {
          Text(record.name).font(.subheadline.weight(.semibold))
            .foregroundStyle(TetherColors.textPrimary)
          Text(record.origin.rawValue)
            .font(.caption2.weight(.bold).monospaced())
            .padding(.horizontal, 6).padding(.vertical, 2)
            .foregroundStyle(TetherColors.accent)
            .background(TetherColors.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
        }
        Text("\(record.algorithm) · \(shortDate(record.createdAt))")
          .font(.caption2.monospaced()).foregroundStyle(TetherColors.textFaint)
        Text(shortFingerprint)
          .font(.caption2.monospaced()).foregroundStyle(TetherColors.textSecondary)
          .lineLimit(1).truncationMode(.middle)
        Text(usedBy.isEmpty ? "not used yet" : "used by \(usedBy.joined(separator: ", "))")
          .font(.caption2.monospaced()).foregroundStyle(TetherColors.textFaint)
        Button {
          UIPasteboard.general.string = record.publicKey
        } label: {
          Text("Copy public key").font(.caption.weight(.semibold))
            .foregroundStyle(TetherColors.accent)
        }
        .padding(.top, 3)
        .buttonStyle(TetherPressStyle())
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14).padding(.vertical, 13)
    .tetherCard()
    .accessibilityIdentifier("homeKeyCard_\(record.name)")
  }

  private var shortFingerprint: String {
    let fp = record.fingerprint.replacingOccurrences(of: "SHA256:", with: "")
    guard fp.count > 16 else { return record.fingerprint }
    return "SHA256:" + fp.prefix(8) + "…" + fp.suffix(6)
  }

  private func shortDate(_ date: Date) -> String {
    let f = DateFormatter(); f.dateFormat = "MMM d"
    return "created " + f.string(from: date)
  }
}

/// One radius for background and border, so the two halves of a card can never disagree.
extension View {
  func tetherCard(cornerRadius: CGFloat = 16) -> some View {
    background(TetherColors.surface, in: RoundedRectangle(cornerRadius: cornerRadius))
      .overlay(RoundedRectangle(cornerRadius: cornerRadius).strokeBorder(TetherColors.border))
  }

  /// The floating capsule used for transient outcomes at the bottom of a screen.
  func tetherPill(border: Color = TetherColors.border) -> some View {
    foregroundStyle(TetherColors.textPrimary)
      .padding(.horizontal, 14).padding(.vertical, 10)
      .background(TetherColors.surface.opacity(0.95), in: Capsule())
      .overlay(Capsule().strokeBorder(border))
      .shadow(radius: 8, y: 2)
  }

  func copyConfirmation(isPresented: Binding<Bool>) -> some View {
    modifier(CopyConfirmation(isPresented: isPresented))
  }

  /// A destructive confirmation driven by the item it acts on, so the item
  /// cannot be nil by the time the button runs.
  func destructiveConfirmation<Item>(
    _ item: Binding<Item?>,
    title: @escaping (Item) -> String,
    actionLabel: String,
    message: String,
    perform: @escaping (Item) -> Void
  ) -> some View {
    confirmationDialog(
      item.wrappedValue.map(title) ?? "",
      isPresented: Binding(get: { item.wrappedValue != nil }, set: { if !$0 { item.wrappedValue = nil } }),
      titleVisibility: .visible
    ) {
      Button(actionLabel, role: .destructive) {
        if let value = item.wrappedValue { perform(value) }
        item.wrappedValue = nil
      }
      Button("Cancel", role: .cancel) { item.wrappedValue = nil }
    } message: {
      Text(message)
    }
  }
}

/// The pill is gone in about a second, so VoiceOver has to be told about the copy directly.
private struct CopyConfirmation: ViewModifier {
  @Binding var isPresented: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func body(content: Content) -> some View {
    content
      .overlay(alignment: .bottom) {
        if isPresented {
          Label("Copied", systemImage: "checkmark.circle.fill")
            .font(.caption.weight(.semibold))
            .tetherPill(border: TetherColors.accent.opacity(0.5))
            .padding(.bottom, 24)
            .transition(TetherMotion.screenTransition(reduceMotion: reduceMotion))
        }
      }
      // Only the arrival is worth a haptic; the timed dismissal is not.
      .sensoryFeedback(trigger: isPresented) { _, shown in shown ? .success : nil }
  }
}

@MainActor
func acknowledgeCopy(_ text: String, announce: String = "Copied", into isPresented: Binding<Bool>) {
  UIPasteboard.general.string = text
  UIAccessibility.post(notification: .announcement, argument: announce)
  withAnimation { isPresented.wrappedValue = true }
  Task {
    try? await Task.sleep(for: .seconds(1.2))
    guard !Task.isCancelled else { return }
    withAnimation { isPresented.wrappedValue = false }
  }
}
