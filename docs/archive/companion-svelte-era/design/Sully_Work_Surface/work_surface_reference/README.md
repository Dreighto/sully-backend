# Sully Mobile Work Surface - Compact Mobile Component (v4 Operator Controls)

A lightweight, data-driven mobile-first HTML/CSS/JS prototype for the Sully Operating-System Work Card. Optimized for iPhone viewports (~390px width) in chat interfaces and mobile dashboard containers, prioritizing safety and human agency.

---

## 🛠️ Key Features in v4

1. **Contextual Action Buttons**
   - **Blocked State**: Renders `Approve` and `Stop task` directly inside both the Compact Card and Expanded Card.
   - **Active State**: Places the `Stop Task` button exclusively in the Expanded Card to avoid accidental taps during execution.
   - **Complete State**: Displays `View Result` inside the Expanded Card once checks are done.
   - **Stopped State**: Renders a `Start Over` button inside the Expanded Card.

2. **Rigorous Safety Confirmations**
   - **Double-Tap Destructive Approval**: Clicking "Approve" on a destructive task (like backup deletion) changes the button styling to crimson warning and asks: `Confirm deletion?`, requiring a second click to execute.
   - **Active Task Halt Warning**: Stopping a running task requires confirmation (`Confirm stopping active task?`) to prevent accidental pipeline interruptions.
   - **Clear Context**: The card always displays the exact action/path being approved or stopped.

3. **Event Propagation Safeguards**
   - All buttons execute `event.stopPropagation()` upon tap. This ensures that tapping actions does **not** accidentally trigger the card's expand/collapse layout animation.
   - Designed for iOS tap boundaries with a minimum touch height of `42px`.

4. **Dynamic Simulated Pipeline Transitions**
   - In the demo, clicking **Confirm deletion?** advances the Blocked task to the **Complete** state.
   - Clicking **Confirm Stop** halts active tasks and loads the final **Stopped** state, showing the message: `Task stopped · Nothing else will run unless you restart it.`
   - Clicking **Start Over** resets the database state so you can test the presets again.

---

## 🔄 Presets

- **CC Only**: Researching stage.
- **CC + Verify**: Handing off to checking phase.
- **AGY + Verify**: Coder active; QA queued.
- **Multi-Agent**: Code builder referencing Memory search.
- **Blocked**: Direct permission prompt. Tapping **Approve** executes backups deletion, advancing task to complete. Tapping **Stop task** halts operations.

---

## 🔍 How to Preview

1. Open the [components/work_card_v4/index.html](components/work_card_v4/index.html) file locally in any web browser.
2. Open Developer Tools (F12), toggle **Device Mode**, and target **iPhone 12/13/14 Pro** (390px wide).
3. Test button clicks to trigger active state machine overrides.

---

## 💻 App Integration & Lifting

- **Action Bindings**: Replace the JS event listeners (`handleApproveClick`, `handleStopClick`) with framework-native state triggers (e.g. Svelte dispatchers or React handlers).
- **Responsive Layout**: Discard styles below the `/* DEMO AND WRAPPER STYLING */` line in `sully_mobile_work_card.css` to lift the card directly into your application bundle.
