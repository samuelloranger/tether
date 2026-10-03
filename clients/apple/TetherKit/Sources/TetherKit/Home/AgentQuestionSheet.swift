import SwiftUI

/// Answers a question Claude holds for the phone: every shape a notification button
/// can't, multi-select and several questions included. It never attaches the session —
/// that would hand the question back to the terminal.
struct AgentQuestionSheet: View {
  let target: AgentQuestionTarget
  let runner: NotificationActionRunner
  var onDone: () -> Void

  private enum Phase {
    case loading
    case failed(String)
    case asking(PendingQuestions)
  }

  @State private var phase = Phase.loading
  @State private var draft = AgentQuestionDraft(questions: [])
  @State private var sending = false
  @State private var sendError: String?

  var body: some View {
    NavigationStack {
      content
        .background(TetherColors.background)
        .navigationTitle(target.link.sessionId)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onDone) }
          ToolbarItem(placement: .confirmationAction) {
            if case .asking = phase {
              Button("Send") { Task { await send() } }
                .disabled(draft.answers() == nil || sending)
                .accessibilityIdentifier("questionSend")
            }
          }
        }
    }
    .task { await load() }
  }

  @ViewBuilder private var content: some View {
    switch phase {
    case .loading:
      VStack(spacing: 10) {
        ProgressView().tint(TetherColors.accent)
        Text("Loading the question…").font(.footnote).foregroundStyle(TetherColors.textSecondary)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    case let .failed(message):
      VStack(spacing: 12) {
        Image(systemName: "questionmark.bubble").font(.largeTitle).foregroundStyle(TetherColors.textFaint)
        Text(message).font(.callout).foregroundStyle(TetherColors.textSecondary).multilineTextAlignment(.center)
        Button("Try again") { Task { await load() } }
          .font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.accent)
      }
      .padding(24)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    case .asking:
      Form {
        ForEach(Array(draft.questions.enumerated()), id: \.offset) { index, question in
          questionSection(question, at: index)
        }
        if let sendError {
          Section { Text(sendError).font(.footnote).foregroundStyle(TetherColors.danger) }
        }
      }
      .scrollContentBackground(.hidden)
      .disabled(sending)
    }
  }

  private func questionSection(_ question: AgentQuestion, at index: Int) -> some View {
    Section {
      ForEach(question.options, id: \.label) { option in
        Button { draft.toggle(option.label, at: index) } label: {
          HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: mark(for: question, selected: draft.isSelected(option.label, at: index)))
              .foregroundStyle(draft.isSelected(option.label, at: index) ? TetherColors.accent : TetherColors.textFaint)
            VStack(alignment: .leading, spacing: 2) {
              Text(option.label).foregroundStyle(TetherColors.textPrimary)
              if let description = option.description, !description.isEmpty {
                Text(description).font(.footnote).foregroundStyle(TetherColors.textSecondary)
              }
            }
          }
        }
        .accessibilityAddTraits(draft.isSelected(option.label, at: index) ? .isSelected : [])
      }
      TextField(
        "Other",
        text: Binding(get: { draft.other[index] }, set: { draft.setOther($0, at: index) }),
        axis: .vertical
      )
    } header: {
      VStack(alignment: .leading, spacing: 4) {
        Text(question.header.uppercased()).font(.caption2.weight(.semibold)).foregroundStyle(TetherColors.accent)
        Text(question.question).font(.headline).foregroundStyle(TetherColors.textPrimary).textCase(nil)
        if question.multiSelect {
          Text("Pick any").font(.caption).foregroundStyle(TetherColors.textSecondary).textCase(nil)
        }
      }
      .padding(.bottom, 4)
    }
  }

  private func mark(for question: AgentQuestion, selected: Bool) -> String {
    switch (question.multiSelect, selected) {
    case (true, true): "checkmark.square.fill"
    case (true, false): "square"
    case (false, true): "largecircle.fill.circle"
    case (false, false): "circle"
    }
  }

  private func load() async {
    phase = .loading
    switch await runner.pendingQuestions(for: target.link) {
    case let .success(pending):
      draft = AgentQuestionDraft(questions: pending.questions)
      phase = .asking(pending)
    case let .failure(error):
      phase = .failed(error.message)
    }
  }

  private func send() async {
    guard case let .asking(pending) = phase, let answers = draft.answers() else { return }
    sending = true
    defer { sending = false }
    let request = NotificationActionRequest(
      link: target.link, expect: AgentExpectation(state: pending.state, version: pending.version),
      input: .answers(answers)
    )
    if let failure = await runner.run(request) {
      sendError = failure
    } else {
      onDone()
    }
  }
}
