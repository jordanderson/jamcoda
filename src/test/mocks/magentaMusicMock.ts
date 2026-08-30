class SoundFontPlayer {
  constructor(..._args: unknown[]) {}

  async start(_sequence: unknown) {}

  async resume() {}

  pause() {}

  stop() {}
}

const sequences = {
  clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value))
  },
}

function midiToSequenceProto(_bytes: Uint8Array) {
  return {
    notes: [],
    totalTime: 0,
    controlChanges: [],
  }
}

export {
  SoundFontPlayer,
  sequences,
  midiToSequenceProto,
}
