import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

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

  var body: some View {
    Button(action: onOpen) {
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
        HStack(spacing: 6) {
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
      .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 16))
      .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(TetherColors.border))
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

  var body: some View {
    HStack(alignment: .top, spacing: 13) {
      RandomartGridView(publicKey: record.publicKey).frame(width: 78).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 7) {
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
          #if canImport(UIKit)
          UIPasteboard.general.string = record.publicKey
          #endif
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
    .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 16))
    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(TetherColors.border))
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
