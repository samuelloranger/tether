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
    input.tap()
    XCTAssertTrue(
      app.keyboards.firstMatch.waitForExistence(timeout: 8),
      "no software keyboard — the simulator has a hardware keyboard connected. "
        + "Simulator ▸ I/O ▸ Keyboard ▸ Connect Hardware Keyboard (off), or "
        + "`defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false`.")
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

  func userBubbles(_ app: XCUIApplication) -> XCUIElementQuery {
    app.staticTexts.matching(identifier: "agentUserBubble")
  }

  func toolCards(_ app: XCUIApplication) -> XCUIElementQuery {
    app.descendants(matching: .any).matching(identifier: "agentToolCard")
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
    // assistant turn, so the tag from the first must still be there after the
    // second (a new bubble per delta would be the regression).
    waitForText(app, "On it [t1]")
    waitForText(app, "Then I'll add the limiter")
    XCTAssertEqual(
      app.descendants(matching: .any).matching(identifier: "agentAssistantTurn").count, 1,
      "streamed deltas must coalesce into one assistant turn")

    XCTAssertTrue(
      toolCards(app).firstMatch.waitForExistence(timeout: 15), "tool call never rendered a card")
    waitForText(app, "function allow")  // the code fence from the closing delta
    waitForText(app, "Done [t1]")
    shot(app, "chat-turn-complete")
  }

  /// A prompt typed while the agent is mid-turn must queue, show as a queued
  /// row, and then fire on its own once `agent.done` lands.
  func testSecondPromptQueuesThenFlushes() throws {
    let app = launchChat("live")
    requireSoftwareKeyboard(app)

    type(app, "First ask")
    tapSend(app)
    waitForText(app, "On it [t1]")  // turn is running

    type(app, "Second ask")
    tapSend(app)
    let queued = app.descendants(matching: .any).matching(identifier: "agentQueuedRow").firstMatch
    XCTAssertTrue(queued.waitForExistence(timeout: 5), "prompt sent mid-turn never queued")
    shot(app, "chat-queued")

    // Turn 2 only exists if the queue flushed after turn 1 finished.
    waitForText(app, "On it [t2]", timeout: 30)
    XCTAssertEqual(userBubbles(app).count, 2, "both prompts must end up as user bubbles")
    XCTAssertFalse(queued.exists, "queued row must clear once the prompt is sent")
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
    XCTAssertTrue(
      toolCards(app).firstMatch.waitForExistence(timeout: 10),
      "the approved tool never rendered a card")
    shot(app, "chat-approved")
  }
}

// MARK: - Scrolling + arriving data

final class AgentChatScrollTests: AgentChatUITestCase {
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
    let app = launchChat("liveLong", arriveAfter: 4)
    XCTAssertTrue(transcript(app).waitForExistence(timeout: 15), "transcript never appeared")

    waitForText(app, "INBOUND prompt from another device", timeout: 25)
    let tail = text(app, containing: "INBOUND turn finished")
    XCTAssertTrue(tail.waitForExistence(timeout: 25), "arriving turn never finished")
    XCTAssertTrue(tail.isHittable, "pinned at the foot, the arriving turn must scroll into view")
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
    XCTAssertTrue(app.keyboards.firstMatch.exists, "keyboard should be up before the drag")

    transcript(app).swipeDown()
    let gone = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
    XCTAssertEqual(
      XCTWaiter.wait(for: [gone], timeout: 8), .completed,
      "dragging the transcript did not dismiss the keyboard")
    shot(app, "scroll-keyboard-dismissed")
  }
}
