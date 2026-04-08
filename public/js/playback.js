// Playback state machine
const Playback = (() => {
  const SPEEDS = [0.5, 1, 2, 5, 10, 30, 60];

  const state = {
    currentTs: 0,
    isPlaying: false,
    speed: 1,
    trimStart: null,
    trimEnd: null,
    minTs: 0,
    maxTs: 0,
  };

  let timer = null;
  let _onTick = null;
  let _onTrimChange = null;
  let _onPlayStateChange = null;

  function init({ onTick, onTrimChange, onPlayStateChange }) {
    _onTick = onTick;
    _onTrimChange = onTrimChange;
    _onPlayStateChange = onPlayStateChange;
  }

  function setRange(minTs, maxTs) {
    state.minTs = minTs;
    state.maxTs = maxTs;
    if (state.trimStart === null || state.trimStart < minTs) state.trimStart = minTs;
    if (state.trimEnd   === null || state.trimEnd   > maxTs) state.trimEnd   = maxTs;
    if (state.currentTs < effectiveStart() || state.currentTs > effectiveEnd()) {
      state.currentTs = effectiveStart();
    }
  }

  function effectiveStart() { return state.trimStart ?? state.minTs; }
  function effectiveEnd()   { return state.trimEnd   ?? state.maxTs; }

  function play() {
    if (state.isPlaying) return;
    // Wrap to start if at end
    if (state.currentTs >= effectiveEnd()) state.currentTs = effectiveStart();
    state.isPlaying = true;
    if (_onPlayStateChange) _onPlayStateChange(true);
    timer = setInterval(() => {
      // Each 50ms wall-clock tick advances `speed` seconds of data time
      state.currentTs += 50 * state.speed;
      if (state.currentTs >= effectiveEnd()) {
        state.currentTs = effectiveEnd();
        _tick();
        pause();
        return;
      }
      _tick();
    }, 50);
  }

  function pause() {
    if (!state.isPlaying) return;
    state.isPlaying = false;
    clearInterval(timer);
    timer = null;
    if (_onPlayStateChange) _onPlayStateChange(false);
  }

  function toggle() {
    if (state.isPlaying) pause(); else play();
  }

  function seek(ts) {
    state.currentTs = Math.max(effectiveStart(), Math.min(effectiveEnd(), ts));
    _tick();
  }

  function skipToStart() {
    seek(effectiveStart());
  }

  function skipToEnd() {
    seek(effectiveEnd());
  }

  function setSpeed(s) {
    state.speed = s;
  }

  function setTrimStart() {
    state.trimStart = state.currentTs;
    if (state.trimEnd !== null && state.trimEnd < state.trimStart) {
      state.trimEnd = state.trimStart;
    }
    if (_onTrimChange) _onTrimChange(effectiveStart(), effectiveEnd());
  }

  function setTrimEnd() {
    state.trimEnd = state.currentTs;
    if (state.trimStart !== null && state.trimStart > state.trimEnd) {
      state.trimStart = state.trimEnd;
    }
    if (_onTrimChange) _onTrimChange(effectiveStart(), effectiveEnd());
  }

  function clearTrim() {
    state.trimStart = state.minTs;
    state.trimEnd   = state.maxTs;
    if (_onTrimChange) _onTrimChange(state.trimStart, state.trimEnd);
  }

  function _tick() {
    if (_onTick) _onTick(state.currentTs);
  }

  function getState() {
    return {
      currentTs:  state.currentTs,
      isPlaying:  state.isPlaying,
      speed:      state.speed,
      trimStart:  effectiveStart(),
      trimEnd:    effectiveEnd(),
      minTs:      state.minTs,
      maxTs:      state.maxTs,
    };
  }

  return {
    SPEEDS,
    init, setRange,
    play, pause, toggle,
    seek, skipToStart, skipToEnd,
    setSpeed,
    setTrimStart, setTrimEnd, clearTrim,
    getState,
  };
})();
