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
    .padding(16)
    .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 22))
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
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(question.message).font(.chat(.body).weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
      if let position {
        Text(position).font(.chat(.caption2).monospacedDigit()).foregroundStyle(TetherColors.textFaint)
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
          .font(.chat(.caption)).foregroundStyle(TetherColors.textSecondary)
          .padding(.leading, 2)
          .accessibilityLabel(field.required ? "\(field.title), required" : field.title)
          .accessibilityAddTraits(.isHeader)
      }
      switch field.kind {
      case .single, .multi:
        VStack(spacing: 0) {
          ForEach(Array(field.choices.enumerated()), id: \.element.value) { index, choice in
            if index > 0 { rule }
            optionRow(field, choice)
          }
          if let custom = field.custom {
            if !field.choices.isEmpty { rule }
            otherRow(custom)
          }
        }
        .background(TetherColors.surfaceRaised, in: RoundedRectangle(cornerRadius: 14))
        .clipShape(RoundedRectangle(cornerRadius: 14))
      case .text:
        textInput(name: field.name, placeholder: field.description.isEmpty ? field.title : field.description)
      case .boolean:
        booleanRow(field)
      }
    }
  }

  private var rule: some View {
    Rectangle().fill(TetherColors.border).frame(height: 0.5).padding(.leading, 46)
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
        Image(systemName: symbol).font(.system(size: 18))
          .foregroundStyle(picked ? TetherColors.textPrimary : TetherColors.textFaint)
          .frame(width: 22)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 1) {
          Text(choice.title).font(.chat(.subheadline)).foregroundStyle(TetherColors.textPrimary)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
          if showsDescription(choice) {
            Text(choice.description).font(.chat(.caption)).foregroundStyle(TetherColors.textSecondary)
              .multilineTextAlignment(.leading)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 12).padding(.vertical, 7)
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .contentShape(Rectangle())
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
          Text("Other\u{2026}").font(.chat(.subheadline)).foregroundStyle(TetherColors.textSecondary)
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
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
    .font(.chat(.subheadline))
    .foregroundStyle(TetherColors.textPrimary)
    .focused($focused, equals: name)
    .submitLabel(.done)
    .onSubmit { focused = nil }
    .padding(.horizontal, 12).padding(.vertical, 8)
    .frame(minHeight: 36)
    .background(TetherColors.surfaceRaised, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(focused == name ? TetherColors.textFaint : TetherColors.border))
    .disabled(!enabled)
    .id("input-" + name)
    .accessibilityLabel(placeholder)
  }

  private func booleanRow(_ field: ChatQuestionField) -> some View {
    Toggle(isOn: Binding(get: { draft.flag(field.name) }, set: { draft.setFlag(field.name, $0) })) {
      Text(field.description.isEmpty ? field.title : field.description)
        .font(.chat(.subheadline)).foregroundStyle(TetherColors.textPrimary)
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
        Text("Decline").font(.chat(.subheadline).weight(.semibold))
          .frame(maxWidth: .infinity, minHeight: 36).padding(.horizontal, 10)
          .foregroundStyle(TetherColors.textPrimary)
          .background(TetherColors.surfaceRaised, in: Capsule())
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
          Text("Submit").font(.chat(.subheadline).weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 36).padding(.horizontal, 10)
            .foregroundStyle(TetherColors.background)
            .background(TetherColors.textPrimary, in: Capsule())
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
        .font(.chat(.caption)).foregroundStyle(TetherColors.textFaint)
      Text("\(Text(question.message).foregroundStyle(TetherColors.textFaint)) \u{2192} \(Text(answer).foregroundStyle(answered ? TetherColors.textSecondary : TetherColors.textFaint).fontWeight(answered ? .medium : .regular))")
        .font(.chat(.footnote))
        .textSelection(.enabled)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(question.message): \(answer)")
  }
}
