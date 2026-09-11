import XCTest

/// Agent-chat E2E against the scripted host (`-agentDemo live|liveLong`), driven
/// through the SOFTWARE keyboard. No tether server, no PTY: the fake host in
/// `AgentChatLiveScript` answers the composer with the same `agent.*` frame
/// sequence a real one streams, so these tests cover the parts the model-level
/// unit tests cannot — that a typed prompt reaches the transcript, that arriving
/// frames land in the right bubble, and that neither the keyboard nor new data
/// moves the transcript out from under the reader.
///
/// Requires the simulator's hardware keyboard to be DISCONNECTED, otherwise the
/// software keyboard stays parked below the screen and `type` fails with the fix.
class AgentChatUITestCase: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  @discardableResult
  func launchChat(_ state: String, arriveAfter: Double? = nil) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-agentDemo", state]
    if let arriveAfter {
      app.launchArguments += ["-arriveAfter", String(arriveAfter)]
    }
    app.launch()
    XCTAssertTrue(
      app.wait(for: .runningForeground, timeout: 15),
      "app never reached foreground (state=\(app.state.rawValue))")
    return app
  }

  /// The composer's input. `TextField(axis: .vertical)` surfaces as a text view
  /// on some iOS versions and a text field on others, so accept either.
  func composer(_ app: XCUIApplication) -> XCUIElement {
    let field = app.textFields["agentComposerInput"].firstMatch
    if field.waitForExistence(timeout: 5) { return field }
    return app.textViews["agentComposerInput"].firstMatch
  }

  func transcript(_ app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any)["agentTranscript"].firstMatch
  }

  /// Put `text` in the composer over a real on-screen keyboard, and prove the
  /// keyboard was actually drawn.
  ///
  /// A synthetic tap does NOT give this SwiftUI TextField first responder — the
  /// keyboard stays parked below the screen (frame y=1004 on a 932pt screen) no
  /// matter how the tap is aimed (element centre, an offset, absolute
  /// coordinates). `typeText` focuses it and the keyboard then rises for real,
  /// on a tall transcript as much as an empty one. So: tap for realism, type,
  /// and only then insist on the keyboard — asserting before typing fails for a
  /// harness reason, not a product one.
  @discardableResult
  func type(_ app: XCUIApplication, _ text: String) -> XCUIElement {
    let input = composer(app)
    XCTAssertTrue(input.waitForExistence(timeout: 15), "composer never appeared")
    // A tap arriving while the transcript is still decelerating only stops the
    // scroll. Let it settle so the tap reaches the composer.
    usleep(900_000)
    input.tap()
    usleep(400_000)
    input.typeText(text)
    XCTAssertTrue(waitForKeyboard(app), keyboardDiagnosis(app))
    return input
  }

  /// Wait for a keyboard a finger could press.
  func waitForKeyboard(_ app: XCUIApplication, timeout: Int = 12) -> Bool {
    for _ in 0..<timeout {
      if keyboardIsUp(app) { return true }
      usleep(500_000)
    }
    return false
  }

  func keyboardDiagnosis(_ app: XCUIApplication) -> String {
    let kb = app.keyboards.firstMatch
    return "no software keyboard on screen (keyboard frame \(kb.frame) vs screen \(app.frame), "
      + "keys=\(kb.keys.count)). A keyboard parked below the screen means the simulator has a "
      + "hardware keyboard connected — Simulator ▸ I/O ▸ Keyboard ▸ Connect Hardware Keyboard "
      + "(off), or `defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false`."
  }


  func tapSend(_ app: XCUIApplication) {
    let send = app.buttons["agentSendButton"].firstMatch
    XCTAssertTrue(send.waitForExistence(timeout: 5), "no send button")
    XCTAssertTrue(send.isEnabled, "send button disabled with a non-empty draft")
    send.tap()
  }

  /// Any on-screen text containing `needle` — the transcript renders one prose
  /// block per paragraph, so content is spread over many static texts.
  func text(_ app: XCUIApplication, containing needle: String) -> XCUIElement {
    app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", needle)).firstMatch
  }

  func waitForText(_ app: XCUIApplication, _ needle: String, timeout: TimeInterval = 20) {
    XCTAssertTrue(
      text(app, containing: needle).waitForExistence(timeout: timeout),
      "never saw text containing \"\(needle)\"")
  }

  /// SwiftUI does not necessarily hang an `accessibilityIdentifier` on the leaf
  /// static text (a `contextMenu` wrapper is enough to move it), so identifier
  /// queries here match any element type.
  func tagged(_ app: XCUIApplication, _ identifier: String) -> XCUIElementQuery {
    app.descendants(matching: .any).matching(identifier: identifier)
  }

  func userBubbles(_ app: XCUIApplication) -> XCUIElementQuery {
    tagged(app, "agentUserBubble")
  }

  func toolCards(_ app: XCUIApplication) -> XCUIElementQuery {
    tagged(app, "agentToolCard")
  }

  /// Whether a keyboard a finger could actually press is on screen.
  ///
  /// Every cheaper check lied: `app.keyboards.firstMatch.exists` is true for a
  /// dismissed keyboard, so is its full `frame.height`, and `keys["space"]`
  /// never matches at all on this simulator's EN/FR keyboard (key identifiers
  /// are localised). A hittable key — any key — plus a frame that is actually on
  /// screen is the combination that holds.
  func keyboardIsUp(_ app: XCUIApplication) -> Bool {
    let kb = app.keyboards.firstMatch
    guard kb.exists, kb.keys.count > 8 else { return false }
    guard kb.frame.minY < app.frame.maxY - 100 else { return false }
    return kb.keys.element(boundBy: 0).isHittable
  }

  /// The ways a finger could reach the composer, in the order a person would
  /// expect them to work.
  func taps(_ app: XCUIApplication, _ input: XCUIElement) -> [(String, () -> Void)] {
    [
      ("element.tap", { input.tap() }),
      ("coord 0.2/0.5", { input.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)).tap() }),
      (
        "app coord at field centre",
        {
          let f = input.frame
          app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: f.midX, dy: f.midY))
            .tap()
        }
      ),
    ]
  }

  func shot(_ app: XCUIApplication, _ name: String) {
    let a = XCTAttachment(screenshot: app.screenshot())
    a.name = name
    a.lifetime = .keepAlways
    add(a)
  }
}

// MARK: - Sending

final class AgentChatSendTests: AgentChatUITestCase {
  /// The whole outbound path: keyboard → draft → send → user bubble → streamed
  /// deltas coalescing into one assistant turn → tool card → usage footer.
  func testTypedPromptStreamsReplyWithToolCard() throws {
    let app = launchChat("live")

    let prompt = "Add a rate limiter to the login route"
    type(app, prompt)
    shot(app, "chat-draft-keyboard")
    tapSend(app)

    let bubble = text(app, containing: prompt)
    XCTAssertTrue(bubble.waitForExistence(timeout: 10), "typed prompt never became a user bubble")
    XCTAssertEqual(userBubbles(app).count, 1, "one send must make exactly one user bubble")

    // The host streams two deltas before the tool call; both belong to the same
    // assistant turn, so the first's text must still be on screen after the
    // second lands. (Per-element coalescing is asserted in AgentChatModelTests —
    // an identifier on a SwiftUI container propagates to every leaf under it, so
    // counting tagged elements here would count paragraphs, not turns.)
    waitForText(app, "On it [t1]")
    waitForText(app, "Then I'll add the limiter")

    // The tool card, asserted the way the user sees it: the collapsed header
    // names the file, and tapping it reveals the tool's result.
    let card = app.buttons.matching(
      NSPredicate(format: "label CONTAINS %@", "src/routes/login.ts")
    ).firstMatch
    XCTAssertTrue(card.waitForExistence(timeout: 15), "tool call never rendered a card")
    card.tap()
    waitForText(app, "export function login")

    waitForText(app, "function allow")  // the code fence from the closing delta
    waitForText(app, "Done [t1]")
    // agent.done carries the turn's usage, which the row shows under the reply.
    waitForText(app, "12.0k↑")
    shot(app, "chat-turn-complete")
  }

  /// A prompt typed while the agent is mid-turn must queue, show as a queued
  /// row, and then fire on its own once `agent.done` lands.
  func testSecondPromptQueuesThenFlushes() throws {
    let app = launchChat("live")

    // "slow" makes the host hold the turn open, so the second prompt really does
    // land on a busy agent instead of racing a turn that already finished.
    type(app, "First ask, slow please")
    tapSend(app)
    waitForText(app, "On it [t1]")  // turn is running

    type(app, "Second ask")
    tapSend(app)
    // It must show up immediately even though the agent is busy — as a queued
    // row, which is the only thing on screen carrying that text until it fires.
    let second = text(app, containing: "Second ask")
    XCTAssertTrue(second.waitForExistence(timeout: 5), "prompt sent mid-turn vanished")
    XCTAssertEqual(
      userBubbles(app).count, 1, "a queued prompt must not become a user bubble yet")
    shot(app, "chat-queued")

    // Turn 2 only exists if the queue flushed after turn 1 finished.
    waitForText(app, "On it [t2]", timeout: 30)
    XCTAssertEqual(userBubbles(app).count, 2, "both prompts must end up as user bubbles")
    XCTAssertTrue(text(app, containing: "Second ask").exists, "the flushed prompt lost its text")
    shot(app, "chat-queue-flushed")
  }

  /// A tool the host will not auto-run: the sheet interrupts the turn, and the
  /// decision typed by the user is what resumes it.
  func testApprovalSheetResumesTheTurn() throws {
    let app = launchChat("live")

    type(app, "Clean reinstall: rm -rf node_modules && bun install")
    tapSend(app)

    let sheet = text(app, containing: "Allow Bash?")
    XCTAssertTrue(sheet.waitForExistence(timeout: 15), "permission request never opened the sheet")
    shot(app, "chat-approval-sheet")

    let allow = app.buttons["Allow once"].firstMatch
    XCTAssertTrue(allow.waitForExistence(timeout: 5), "no Allow once button")
    allow.tap()

    waitForText(app, "[approved]")
    let card = app.buttons.matching(
      NSPredicate(format: "label CONTAINS %@", "node_modules")
    ).firstMatch
    XCTAssertTrue(card.waitForExistence(timeout: 10), "the approved tool never rendered a card")
    shot(app, "chat-approved")
  }
}

// MARK: - Scrolling + arriving data

final class AgentChatScrollTests: AgentChatUITestCase {
  /// Read history, then answer: after the transcript has been scrolled up, the
  /// composer must still take text over a real keyboard.
  func testComposerTakesTextAfterScrollingHistory() throws {
    let app = launchChat("liveLong")
    let scroll = transcript(app)
    XCTAssertTrue(scroll.waitForExistence(timeout: 15), "transcript never appeared")

    for _ in 0..<4 { scroll.swipeDown() }
    usleep(1_500_000)
    XCTAssertTrue(
      app.buttons["agentJumpToLatest"].firstMatch.exists, "expected to be parked up in history")

    let input = type(app, "answer while reading history")
    let typed = (input.value as? String) ?? ""
    XCTAssertTrue(
      typed.contains("answer while reading history"),
      "the composer took no text after the transcript was scrolled (value=\(typed))")
    shot(app, "focus-after-scroll")

    // Typing must not have thrown the reader back to the foot.
    XCTAssertTrue(
      app.buttons["agentJumpToLatest"].firstMatch.exists,
      "typing scrolled the transcript to the foot")
  }

  /// Pinned at the foot, raising the keyboard must keep the newest line visible.
  /// The keyboard shrinks the viewport without scrolling, so the foot used to
  /// end up behind the keys — with no jump-to-latest offered either, because
  /// follow was still on.
  func testKeyboardRiseKeepsTheFootVisibleWhenPinned() throws {
    let app = launchChat("liveLong")
    XCTAssertTrue(transcript(app).waitForExistence(timeout: 15), "transcript never appeared")
    sleep(2)

    // The tail of the seeded transcript: turn 5's usage line.
    let tail = text(app, containing: "21.6k↑")
    XCTAssertTrue(tail.waitForExistence(timeout: 10), "transcript did not open at the foot")

    type(app, "x")
    XCTAssertTrue(
      tail.isHittable,
      "raising the keyboard hid the newest line behind it while the chat was pinned at the foot")
    XCTAssertFalse(
      app.buttons["agentJumpToLatest"].firstMatch.exists,
      "still pinned at the foot, so no jump-to-latest should be offered")
    shot(app, "keyboard-up-at-foot")
  }

  /// Scrolled up to read history, the keyboard rising must not scroll the
  /// transcript: the same message stays on screen and follow stays off (the
  /// jump-to-latest affordance is still offered).
  func testKeyboardRiseDoesNotMoveTheTranscript() throws {
    let app = launchChat("liveLong")
    let scroll = transcript(app)
    XCTAssertTrue(scroll.waitForExistence(timeout: 15), "transcript never appeared")

    for _ in 0..<4 { scroll.swipeDown() }
    let jump = app.buttons["agentJumpToLatest"].firstMatch
    XCTAssertTrue(jump.waitForExistence(timeout: 5), "scrolling up must offer jump-to-latest")

    let anchor = userBubbles(app).element(boundBy: 0)
    XCTAssertTrue(anchor.exists, "no user bubble visible after scrolling up")
    let label = anchor.label
    let before = anchor.frame
    shot(app, "scroll-before-keyboard")

    type(app, "x")
    shot(app, "scroll-after-keyboard")

    let same = text(app, containing: label)
    XCTAssertTrue(same.exists, "the message being read disappeared when the keyboard rose")
    XCTAssertTrue(same.isHittable, "the message being read was pushed off screen")
    XCTAssertTrue(
      jump.exists, "the keyboard re-armed follow — the transcript scrolled to the foot")
    // The composer lifts over the keyboard; the transcript's content must not be
    // yanked. Allow a little for the shortened viewport, not a page.
    XCTAssertLessThan(
      abs(same.frame.origin.y - before.origin.y), 120,
      "the transcript jumped when the keyboard appeared")
  }

  /// Sitting at the foot, a turn arriving from the server must scroll into view
  /// on its own.
  func testArrivingTurnFollowsTheFootWhenPinned() throws {
    let app = launchChat("liveLong", arriveAfter: 6)
    XCTAssertTrue(transcript(app).waitForExistence(timeout: 15), "transcript never appeared")

    // A chat that opens at the foot is FOLLOWING: no jump-to-latest offered.
    // (It was offered here, because the open-time geometry latched follow off.)
    sleep(2)
    XCTAssertFalse(
      app.buttons["agentJumpToLatest"].firstMatch.exists,
      "a chat opened at the foot must not start out unfollowed")
    shot(app, "arrival-at-foot-before")

    waitForText(app, "INBOUND prompt from another device", timeout: 25)
    // Following means the arriving turn is carried into view as it streams —
    // its opening line must be on screen, not waiting behind jump-to-latest.
    let opening = text(app, containing: "INBOUND turn: picking this up now")
    XCTAssertTrue(opening.waitForExistence(timeout: 25), "arriving turn never streamed")
    XCTAssertTrue(opening.isHittable, "pinned at the foot, the arriving turn must scroll into view")
    XCTAssertFalse(
      app.buttons["agentJumpToLatest"].firstMatch.exists,
      "follow was dropped while the turn arrived")
    waitForText(app, "INBOUND turn finished", timeout: 25)
    shot(app, "arrival-followed")
  }

  /// Scrolled up, the same arrival must NOT steal the viewport — it waits behind
  /// the jump-to-latest button.
  func testArrivingTurnHoldsPositionWhenScrolledUp() throws {
    let app = launchChat("liveLong", arriveAfter: 8)
    let scroll = transcript(app)
    XCTAssertTrue(scroll.waitForExistence(timeout: 15), "transcript never appeared")

    for _ in 0..<4 { scroll.swipeDown() }
    let anchor = userBubbles(app).element(boundBy: 0)
    XCTAssertTrue(anchor.exists, "no user bubble visible after scrolling up")
    let label = anchor.label
    shot(app, "arrival-scrolled-up")

    // Wait out the arrival (8s + ~2s of streaming).
    sleep(14)
    XCTAssertTrue(
      text(app, containing: label).isHittable,
      "the arriving turn scrolled the reader away from where they were")
    let jump = app.buttons["agentJumpToLatest"].firstMatch
    XCTAssertTrue(jump.exists, "no jump-to-latest while parked above an arrived turn")
    shot(app, "arrival-held")

    jump.tap()
    let tail = text(app, containing: "INBOUND turn finished")
    XCTAssertTrue(tail.waitForExistence(timeout: 10), "jump-to-latest did not reach the arrival")
    XCTAssertTrue(tail.isHittable, "jump-to-latest left the newest turn off screen")
    shot(app, "arrival-jumped")
  }

  /// A tap in the transcript puts the keyboard away — the view wires that up
  /// explicitly (`simultaneousGesture` + `resignFirstResponder`) so that reading
  /// the conversation does not mean reaching for a dismiss key.
  ///
  /// Its sibling behaviour, `scrollDismissesKeyboard(.interactively)`, is NOT
  /// asserted here: a synthetic drag does not engage interactive dismissal, and a
  /// 469-frame recording of one such run contains no keyboard-down caused by a
  /// drag at all. Verify that one by hand.
  func testTappingTranscriptDismissesKeyboard() throws {
    let app = launchChat("liveLong")
    type(app, "x")
    XCTAssertTrue(keyboardIsUp(app), "keyboard should be up before the tap")
    shot(app, "scroll-keyboard-up")

    // Upper half on purpose: the transcript ignores the keyboard's safe area, so
    // its element frame runs UNDER the keyboard and a tap low down lands on keys.
    transcript(app).coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()

    var gone = false
    for _ in 0..<16 {
      gone = !keyboardIsUp(app)
      if gone { break }
      usleep(500_000)
    }
    shot(app, "scroll-keyboard-dismissed")
    XCTAssertTrue(gone, "tapping the transcript did not dismiss the keyboard")
  }
}
