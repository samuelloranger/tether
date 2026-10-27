import SwiftUI

/// An agent's logo: vector from the package's asset catalog, tinted with the text colour when it is
/// single-colour. An agent this app does not know gets a plain chat bubble.
struct ChatAgentMark: View {
  let agent: ChatAgentProfile?
  var size: CGFloat = 14

  var body: some View {
    Group {
      if let agent {
        Image(agent.iconAsset, bundle: .module)
          .renderingMode(agent.tintsIcon ? .template : .original)
          .resizable().scaledToFit()
          .foregroundStyle(TetherColors.textPrimary)
      } else {
        Image(systemName: "bubble.left").resizable().scaledToFit().foregroundStyle(TetherColors.textSecondary)
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}
