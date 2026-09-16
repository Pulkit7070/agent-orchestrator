package acp

import (
	"context"
	"encoding/json"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// idleActivityTimeout bounds how long an ACP turn may go with no provider signal
// before AO surfaces a non-terminal "waiting on the agent" row. Native agents
// differ in how they behave when a connection drops mid-turn: some return a
// terminal error, but others (observed with OpenCode) leave the prompt call open
// and emit nothing, so AO's turn stays Working with no explanation. This bound
// makes that stall visible without cancelling the turn, because a slow-but-legit
// turn also streams no updates while the agent is thinking. It is a variable so
// the watchdog can be exercised without real-time delays in tests.
var idleActivityTimeout = 3 * time.Minute

// idleStallItemID is the stable provider item id for a turn's idle-stall row so
// repeated evaluations collapse onto a single activity instead of stacking rows.
func idleStallItemID(turnID string) string {
	if turnID == "" {
		return "acp-idle"
	}
	return "acp-idle:" + turnID
}

// noteActivity records that the provider produced a signal on the active turn.
func (c *conversation) noteActivity() {
	c.lastActivityNanos.Store(time.Now().UnixNano())
}

// markIdleStalled flips the turn into the stalled state, returning true only for
// the transition so the surfaced row is emitted exactly once. It refuses once the
// turn is no longer the active one or has begun settling, closing the race where a
// watchdog tick in flight could re-surface a stall that finishPrompt just settled.
func (c *conversation) markIdleStalled(turnID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.idleStalled || c.activeTurn != turnID || c.settlingTurn == turnID {
		return false
	}
	c.idleStalled = true
	return true
}

// clearIdleStall leaves the stalled state, returning true only when a stall was
// actually open. finishPrompt and the watchdog both call it; the loser is a no-op
// so the row is never settled twice.
func (c *conversation) clearIdleStall() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.idleStalled {
		return false
	}
	c.idleStalled = false
	return true
}

// watchTurnIdle surfaces, but never cancels, a turn whose agent has gone silent.
// It runs for the life of one turn (ctx is cancelled when runTurn returns or the
// turn is interrupted). On crossing the idle bound with no activity it emits a
// single running system row; if activity resumes it settles that row as recovered
// and keeps watching. finishPrompt settles a still-open row on turn completion.
func (c *conversation) watchTurnIdle(ctx context.Context, turnID string) {
	timeout := idleActivityTimeout
	if timeout <= 0 {
		return
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			idle := time.Duration(time.Now().UnixNano() - c.lastActivityNanos.Load())
			if idle < timeout {
				// Activity resumed inside the window. Settle any surfaced stall as
				// recovered, then wait out only the remaining idle time.
				if c.clearIdleStall() {
					c.settleIdleStall(turnID, domain.ActivityStatusRecovered)
				}
				timer.Reset(timeout - idle)
				continue
			}
			if c.markIdleStalled(turnID) {
				c.emitIdleStall(turnID, idle)
			}
			timer.Reset(timeout)
		}
	}
}

// emitIdleStall surfaces the non-terminal "the agent has gone quiet" row.
func (c *conversation) emitIdleStall(turnID string, idle time.Duration) {
	detail, _ := json.Marshal(map[string]any{
		"event":       "provider.idle",
		"idleSeconds": int(idle.Seconds()),
	})
	c.emit(ports.ChatEvent{
		Kind:           ports.ChatEventActivityStarted,
		ProviderTurnID: turnID,
		ProviderItemID: idleStallItemID(turnID),
		ActivityKind:   domain.ActivityKindSystem,
		ActivityStatus: domain.ActivityStatusRunning,
		Summary:        "Waiting for the agent to respond",
		Detail:         detail,
	})
}

// settleIdleStall closes the idle row with the given terminal-for-the-row status.
func (c *conversation) settleIdleStall(turnID string, status domain.ActivityStatus) {
	c.emit(ports.ChatEvent{
		Kind:           ports.ChatEventActivityCompleted,
		ProviderTurnID: turnID,
		ProviderItemID: idleStallItemID(turnID),
		ActivityKind:   domain.ActivityKindSystem,
		ActivityStatus: status,
		Summary:        "Waiting for the agent to respond",
	})
}
