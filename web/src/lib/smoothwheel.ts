// Mouse-wheel scrolling that glides, for a scrolling element (the editor's).
// WebKitGTK animates each wheel click on its own: ease-in-out from a standstill, or ease-out when
// a click lands during the previous one. Spinning the wheel then moves the page in surges, fast
// then nearly still at every click, where Firefox glides. Here every click moves a target, and the
// position follows it like a critically damped spring: its speed carries over from click to click,
// so a spinning wheel scrolls at an even pace, and it settles without overshooting.
//   Only whole wheel clicks (wheelDelta a multiple of 120). A touchpad's fine-grained deltas, a
//   tilted wheel, Shift (sideways) and Ctrl (zoom) stay WebKit's, and so does its touchpad momentum.
//   Same distance per click as WebKit's own (the event's deltaY); time-based, so the same at any
//   refresh rate.
//   The listener that can cancel WebKit's scrolling is only there while the wheel turns: with it,
//   WebKit sends every wheel event through the page's thread first, which made touchpad scrolling
//   twice as uneven. So the first click of a turn can't be cancelled; it starts the glide anyway,
//   and the glide's first step stops WebKit's own animation of that click (any page scroll does).
//   Someone else scrolling meanwhile (CodeMirror keeping lines in place, a jump, the scrollbar) is
//   taken as is: the glide carries on from there.

const W = 0.04; // spring frequency, per ms: most of a click in ~4 frames, settled ~120 ms after the last one
const KICK = 0.7; // starting speed from a standstill, so the first click moves at once
const IDLE = 400; // ms after the last click before WebKit gets the wheel back

type Wheel = WheelEvent & { wheelDeltaY?: number };

export function smoothWheel(el: HTMLElement): () => void {
  let pos = 0, vel = 0, target = 0, set = 0, last = 0, raf = 0;
  let adopt = false; // first frame of a glide begun by an uncancellable click: take WebKit's start as ours
  let catching = false, idle = 0;

  const maxTop = () => el.scrollHeight - el.clientHeight;

  function frame(now: number) {
    // Moved by someone else since the last frame: follow along.
    const moved = el.scrollTop - set;
    if (adopt) { pos = el.scrollTop; adopt = false; }
    else if (Math.abs(moved) > 1.5) { pos += moved; target += moved; }
    target = Math.max(0, Math.min(target, maxTop()));
    const dir = Math.sign(target - pos);
    for (let dt = Math.min(now - last, 64); dt > 0; dt -= 1) {
      const step = Math.min(dt, 1);
      vel += (W * W * (target - pos) - 2 * W * vel) * step;
      pos += vel * step;
    }
    last = now;
    // Never past the target (the kick could carry it there), and done when it's there.
    if (dir !== 0 && Math.sign(target - pos) !== dir) { pos = target; vel = 0; }
    const done = Math.abs(target - pos) < 0.5 && Math.abs(vel) < 0.01;
    if (done) pos = target;
    el.scrollTop = pos;
    set = el.scrollTop;
    raf = done ? 0 : requestAnimationFrame(frame);
  }

  // A wheel click: move the target, and glide there.
  function click(e: Wheel, cancellable: boolean) {
    const delta = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY;
    const top = maxTop(), now = el.scrollTop;
    // At the end already: let the page do what it does there.
    if (!raf && ((delta > 0 && now >= top - 0.5) || (delta < 0 && now <= 0.5))) return;
    if (cancellable) e.preventDefault();
    if (!raf) {
      pos = target = set = now; vel = 0;
      adopt = !cancellable; // WebKit may have begun moving for this click before our first frame
    } else if (Math.sign(delta) !== Math.sign(target - pos)) {
      target = pos; vel = 0; // turned around: stop, then go the new way
    }
    const fromRest = vel === 0;
    target = Math.max(0, Math.min(target + delta, top));
    if (fromRest) vel = KICK * W * (target - pos);
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }

  const isClick = (e: Wheel) => !e.ctrlKey && !e.shiftKey && !e.deltaX && !!e.deltaY && !!e.wheelDeltaY && e.wheelDeltaY % 120 === 0;

  // While the wheel turns: clicks are ours (cancelled), the rest WebKit's.
  function catcher(e: Wheel) {
    if (!isClick(e)) return;
    click(e, true);
    clearTimeout(idle);
    idle = setTimeout(release, IDLE);
  }
  function release() {
    if (raf) { idle = setTimeout(release, IDLE); return; }
    el.removeEventListener("wheel", catcher);
    catching = false;
  }
  // Always (passive, so WebKit keeps scrolling on its own thread): the first click of a turn.
  function watcher(e: Wheel) {
    if (catching || !isClick(e)) return;
    click(e, false);
    catching = true;
    el.addEventListener("wheel", catcher, { passive: false });
    idle = setTimeout(release, IDLE);
  }

  el.addEventListener("wheel", watcher, { passive: true });
  return () => {
    el.removeEventListener("wheel", watcher);
    el.removeEventListener("wheel", catcher);
    clearTimeout(idle);
    cancelAnimationFrame(raf);
  };
}
