import SwiftUI
import UIKit

/// Pinned above the composer like the permission card, so a question is never lost in the scroll.
struct QuestionCard: View {
  let question: ChatQuestion
  let position: String?
  let enabled: Bool
  let respond: (ChatQuestionAction, [String: ChatQuestionValue]) -> Void
  let typing: (Bool) -> Void

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @State private var draft = ChatQuestionDraft()
  @State private var contentHeight: CGFloat = 120
  @FocusState private var focused: String?

  private var fields: [ChatQuestionField] { question.fields }
  private var tapSubmits: Bool { draft.submitsOnTap(fields) }
  private var showsSubmit: Bool { !tapSubmits || fields.isEmpty || !draft.customOpen.isEmpty }
  private var canSubmit: Bool { enabled && draft.canSubmit(fields) }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      header
      if !fields.isEmpty { fieldList }
      actions
    }
    .padding(14)
    .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 18))
    .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(TetherColors.accent.opacity(0.45)))
    .shadow(color: .black.opacity(0.18), radius: 10, y: 3)
    .accessibilityElement(children: .contain)
    .onChange(of: focused) { _, now in typing(now != nil) }
    .task {
      #if DEBUG
      guard ChatFixture.openQuestionOther, let field = fields.first(where: { $0.custom != nil }),
        let custom = field.custom
      else { return }
      draft.openCustom(custom.name)
      draft.setText(custom.name, "Whatever the repo already uses")
      try? await Task.sleep(nanoseconds: 700_000_000)
      focused = custom.name
      #endif
    }
  }

  private var header: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: "questionmark.bubble").foregroundStyle(TetherColors.accent)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        Text("QUESTION").font(.caption2.weight(.bold)).tracking(0.8).foregroundStyle(TetherColors.textFaint)
        Text(question.message).font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
          .lineLimit(4)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 0)
      if let position {
        Text(position).font(.caption2.weight(.semibold).monospaced()).foregroundStyle(TetherColors.textFaint)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Question: \(question.message)")
  }

  private var maxListHeight: CGFloat {
    UIScreen.main.bounds.height * (focused == nil ? 0.45 : 0.34)
  }

  private var fieldList: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          ForEach(fields) { field in section(field) }
        }
        .padding(.bottom, 4)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
      }
      .scrollBounceBehavior(.basedOnSize)
      .frame(height: min(contentHeight, maxListHeight))
      .task(id: focused) {
        guard let name = focused else { return }
        try? await Task.sleep(nanoseconds: 700_000_000)
        withAnimation { proxy.scrollTo("input-" + name, anchor: .bottom) }
      }
    }
  }

  @ViewBuilder private func section(_ field: ChatQuestionField) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      if fields.count > 1 || field.required {
        Text(field.title + (field.required ? " *" : ""))
          .font(.caption.weight(.semibold)).foregroundStyle(TetherColors.textSecondary)
          .accessibilityLabel(field.required ? "\(field.title), required" : field.title)
          .accessibilityAddTraits(.isHeader)
      }
      switch field.kind {
      case .single, .multi:
        ForEach(field.choices, id: \.value) { choice in optionRow(field, choice) }
        if let custom = field.custom { otherRow(custom) }
      case .text:
        textInput(name: field.name, placeholder: field.description.isEmpty ? field.title : field.description)
      case .boolean:
        booleanRow(field)
      }
    }
  }

  private func showsDescription(_ choice: ChatQuestionChoice) -> Bool {
    !choice.description.isEmpty && choice.description.caseInsensitiveCompare(choice.title) != .orderedSame
  }

  private func optionRow(_ field: ChatQuestionField, _ choice: ChatQuestionChoice) -> some View {
    let picked = draft.isPicked(field, choice.value)
    let multi: Bool = { if case .multi = field.kind { return true } else { return false } }()
    let symbol = multi ? (picked ? "checkmark.square.fill" : "square") : (picked ? "largecircle.fill.circle" : "circle")
    return Button {
      draft.choose(field, choice.value)
      if tapSubmits { respond(.accept, draft.content(fields)) }
    } label: {
      HStack(spacing: 10) {
        Image(systemName: symbol).font(.system(size: 17))
          .foregroundStyle(picked ? TetherColors.accent : TetherColors.textFaint)
          .frame(width: 22)
          .accessibilityHidden(true)
        let stacked = dynamicTypeSize.isAccessibilitySize
        let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 1)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
        layout {
          Text(choice.title).font(.subheadline).foregroundStyle(TetherColors.textPrimary)
            .lineLimit(stacked ? 4 : 2)
            .multilineTextAlignment(.leading)
          if showsDescription(choice) {
            Text(choice.description).font(.caption).foregroundStyle(TetherColors.textSecondary)
              .lineLimit(stacked ? 3 : 1)
              .multilineTextAlignment(.leading)
          }
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 10).padding(.vertical, 6)
      .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
      .background(picked ? TetherColors.accent.opacity(0.10) : TetherColors.background.opacity(0.5),
        in: RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10)
        .strokeBorder(picked ? TetherColors.accent.opacity(0.55) : TetherColors.border))
      .contentShape(RoundedRectangle(cornerRadius: 10))
    }
    .buttonStyle(TetherPressStyle())
    .disabled(!enabled)
    .opacity(enabled ? 1 : 0.5)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(showsDescription(choice) ? "\(choice.title), \(choice.description)" : choice.title)
    .accessibilityAddTraits(picked ? [.isButton, .isSelected] : .isButton)
  }

  @ViewBuilder private func otherRow(_ custom: ChatQuestionCompanion) -> some View {
    if draft.customOpen.contains(custom.name) {
      textInput(name: custom.name, placeholder: "Your own answer, or a note")
    } else {
      Button {
        draft.openCustom(custom.name)
        focused = custom.name
      } label: {
        HStack(spacing: 10) {
          Image(systemName: "pencil").font(.system(size: 15)).foregroundStyle(TetherColors.textFaint)
            .frame(width: 22)
            .accessibilityHidden(true)
          Text("Other\u{2026}").font(.subheadline).foregroundStyle(TetherColors.textSecondary)
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
        .contentShape(RoundedRectangle(cornerRadius: 10))
      }
      .buttonStyle(TetherPressStyle())
      .disabled(!enabled)
      .opacity(enabled ? 1 : 0.5)
      .accessibilityLabel("Other")
      .accessibilityHint("Type your own answer")
    }
  }

  private func textInput(name: String, placeholder: String) -> some View {
    TextField(
      "", text: Binding(get: { draft.text(name) }, set: { draft.setText(name, $0) }),
      prompt: Text(placeholder).foregroundStyle(TetherColors.placeholder), axis: .vertical
    )
    .lineLimit(1...4)
    .font(.subheadline)
    .foregroundStyle(TetherColors.textPrimary)
    .focused($focused, equals: name)
    .submitLabel(.done)
    .onSubmit { focused = nil }
    .padding(.horizontal, 12).padding(.vertical, 8)
    .frame(minHeight: 36)
    .background(TetherColors.surfaceRaised, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(focused == name ? TetherColors.accent.opacity(0.55) : TetherColors.border))
    .disabled(!enabled)
    .id("input-" + name)
    .accessibilityLabel(placeholder)
  }

  private func booleanRow(_ field: ChatQuestionField) -> some View {
    Toggle(isOn: Binding(get: { draft.flag(field.name) }, set: { draft.setFlag(field.name, $0) })) {
      Text(field.description.isEmpty ? field.title : field.description)
        .font(.subheadline).foregroundStyle(TetherColors.textPrimary)
    }
    .tint(TetherColors.accent)
    .padding(.horizontal, 10)
    .frame(minHeight: 36)
    .disabled(!enabled)
  }

  private var actions: some View {
    let layout = dynamicTypeSize.isAccessibilitySize
      ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))
    return layout {
      Button { respond(.decline, [:]) } label: {
        Text("Decline").font(.subheadline.weight(.medium))
          .frame(maxWidth: .infinity, minHeight: 34).padding(.horizontal, 10)
          .foregroundStyle(TetherColors.danger)
          .background(TetherColors.danger.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
          .hitSlop(vertical: 5)
      }
      .buttonStyle(TetherPressStyle())
      .disabled(!enabled)
      .opacity(enabled ? 1 : 0.5)
      .accessibilityLabel("Decline to answer")
      if showsSubmit {
        Button {
          focused = nil
          respond(.accept, draft.content(fields))
        } label: {
          Text("Submit").font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 34).padding(.horizontal, 10)
            .foregroundStyle(TetherColors.onAccent)
            .background(TetherColors.accent, in: RoundedRectangle(cornerRadius: 10))
            .hitSlop(vertical: 5)
        }
        .buttonStyle(TetherPressStyle())
        .disabled(!canSubmit)
        .opacity(canSubmit ? 1 : 0.4)
        .accessibilityLabel("Submit")
      }
    }
  }
}

/// A resolved question stays in the transcript as one quiet line.
struct ResolvedQuestionRow: View {
  let question: ChatQuestion

  private var answer: String {
    switch question.state {
    case .pending: ""
    case .answered: question.answerSummary ?? "Answered"
    case .declined: "Declined"
    case .cancelled: "No answer"
    }
  }

  private var answered: Bool { question.answerSummary != nil }

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: answered ? "checkmark.bubble" : "bubble")
        .font(.caption).foregroundStyle(TetherColors.textFaint)
      Text("\(Text(question.message).foregroundStyle(TetherColors.textFaint)) \u{2192} \(Text(answer).foregroundStyle(answered ? TetherColors.textSecondary : TetherColors.textFaint).fontWeight(answered ? .medium : .regular))")
        .font(.footnote)
        .textSelection(.enabled)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(question.message): \(answer)")
  }
}
