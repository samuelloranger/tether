import XCTest

/// Agent-chat E2E against the scripted host (`-agentDemo live|liveLong`), driven
/// through the SOFTWARE keyboard. No tether server, no PTY: the fake host in
/// `AgentChatLiveScript` answers the composer with the same `agent.*` frame
/// sequence a real one streams, so these tests cover the parts the model-level
/// unit tests cannot — that a typed prompt reaches the transcript, that arriving
/// frames land in the right bubble, and that neither the keyboard nor new data
/// moves the transcript out from under the reader.
///
/// Requires the simulator's hardware keyboard to be DISCONNECTED, otherwise no
/// software keyboard appears and `requireSoftwareKeyboard` fails with the fix.
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

  /// Focus the composer and prove the on-screen keyboard is really up — the
  /// point of the suite. A connected hardware keyboard makes every typing test
  /// pass for the wrong reason, so fail loudly with the remedy instead.
  func requireSoftwareKeyboard(_ app: XCUIApplication) {
    let input = composer(app)
    XCTAssertTrue(input.waitForExistence(timeout: 15), "composer never appeared")
    // A tap arriving while the transcript is still decelerating only stops the
    // scroll — it never reaches the composer. Let the scroll settle first.
    usleep(900_000)
    // Neither `app.keyboards.firstMatch.exists` nor its `frame.height` proves a
    // keyboard is on screen — a dismissed keyboard still matches and still
    // reports full height, which passed a test whose screenshot had no keyboard
    // in it at all. A key you could actually press is the honest signal.
    let key = app.keyboards.firstMatch.keys["space"]
    var up = false
    // The first tap after a scroll is swallowed (the scroll view eats it), so
    // retry — and say which attempt worked, because "always needs two taps" and
    // "never focuses" are different bugs.
    for attempt in 1...3 where !up {
      // Left of centre, not `input.tap()`: the element's centre is close enough
      // to the jump-to-latest button that the tap can hit that instead, which
      // scrolls the transcript to the foot and leaves the composer unfocused.
      input.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)).tap()
      for _ in 0..<8 {
        up = key.exists && key.isHittable
        if up { break }
        usleep(500_000)
      }
      print("KEYBOARD_ATTEMPT=\(attempt) up=\(up)")
      if !up { usleep(700_000) }
    }
    XCTAssertTrue(
      up,
      "no software keyboard on screen. Either the tap did not focus the composer, or the "
        + "simulator has a hardware keyboard connected — Simulator ▸ I/O ▸ Keyboard ▸ "
        + "Connect Hardware Keyboard (off), or `defaults write "
        + "com.apple.iphonesimulator ConnectHardwareKeyboard -bool false`.")
    // The field takes first responder a beat after the keyboard animates in;
    // typing into the gap drops the first character.
    usleep(600_000)
  }

  func type(_ app: XCUIApplication, _ text: String) {
    composer(app).typeText(text)
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
    requireSoftwareKeyboard(app)

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
    requireSoftwareKeyboard(app)

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
    requireSoftwareKeyboard(app)

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
  /// Read history, then answer: the composer must still take focus after the
  /// transcript has been scrolled. Tries a tap first, then typing straight into
  /// the field, and says which one worked — "needs a second tap" and "cannot be
  /// focused at all" are different bugs.
  func testComposerFocusesAfterScrollingHistory() throws {
    let app = launchChat("liveLong")
    let scroll = transcript(app)
    XCTAssertTrue(scroll.waitForExistence(timeout: 15), "transcript never appeared")

    let key = app.keyboards.firstMatch.keys["space"]
    let input = composer(app)
    XCTAssertTrue(input.waitForExistence(timeout: 10), "composer never appeared")

    // Baseline: focusable before any scrolling.
    input.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)).tap()
    var up = false
    for _ in 0..<8 where !up {
      up = key.exists && key.isHittable
      usleep(500_000)
    }
    print("FOCUS_BEFORE_SCROLL=\(up)")
    XCTAssertTrue(up, "composer could not be focused even before scrolling")
    shot(app, "focus-before-scroll")

    // Dismiss, scroll into history, and try again.
    scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)).tap()
    usleep(1_200_000)
    for _ in 0..<4 { scroll.swipeDown() }
    usleep(1_500_000)

    input.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)).tap()
    var afterTap = false
    for _ in 0..<8 where !afterTap {
      afterTap = key.exists && key.isHittable
      usleep(500_000)
    }
    print("FOCUS_AFTER_SCROLL_BY_TAP=\(afterTap)")

    // Whether the FIELD is focused is a separate question from whether the
    // KEYBOARD is drawn: a recording of this showed a blinking caret in the
    // composer with no keyboard on screen, which is unusable but would pass any
    // focus-only check.
    input.typeText("zz")
    let typed = (input.value as? String) ?? ""
    var keyboardAfterTyping = false
    for _ in 0..<8 where !keyboardAfterTyping {
      keyboardAfterTyping = key.exists && key.isHittable
      usleep(500_000)
    }
    print("FOCUS_AFTER_SCROLL_VALUE=\(typed) KEYBOARD=\(keyboardAfterTyping)")
    shot(app, "focus-after-scroll")

    XCTAssertTrue(
      typed.contains("zz"),
      "the composer took no text after the transcript was scrolled (value=\(typed))")
    XCTAssertTrue(
      afterTap || keyboardAfterTyping,
      "the composer accepts text but no software keyboard is drawn once the transcript has "
        + "been scrolled — nothing a real finger could type into")
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

    requireSoftwareKeyboard(app)
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

  /// Dragging the transcript with the keyboard up dismisses it
  /// (`scrollDismissesKeyboard(.interactively)`) instead of scrolling under it.
  func testDraggingTranscriptDismissesKeyboard() throws {
    let app = launchChat("liveLong")
    requireSoftwareKeyboard(app)
    XCTAssertTrue(
      app.keyboards.firstMatch.keys["space"].isHittable, "keyboard should be up before the drag")
    shot(app, "scroll-keyboard-up")

    // A real finger drag, not `swipeDown()`: interactive dismissal tracks the
    // gesture, and a flick is over before it can take the keyboard with it.
    // Both ends stay in the upper half: the transcript ignores the keyboard's
    // safe area, so its element frame runs UNDER the keyboard and a drag ending
    // at dy 0.95 lands on the keys and scrolls nothing at all.
    let scroll = transcript(app)
    let top = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
    let bottom = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55))
    top.press(forDuration: 0.2, thenDragTo: bottom)
    let gone = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "isHittable == false"),
      object: app.keyboards.firstMatch.keys["space"])
    XCTAssertEqual(
      XCTWaiter.wait(for: [gone], timeout: 8), .completed,
      "dragging the transcript did not dismiss the keyboard")
    shot(app, "scroll-keyboard-dismissed")
  }
}
