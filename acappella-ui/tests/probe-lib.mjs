import { LIBRARY, buildSong } from '../src/lib/library.js'

const sc = buildSong(LIBRARY[0])
console.log(sc.title, sc.bpm, sc.bar, 'parts', sc.parts.length)
console.log(sc.parts.map((p) => p.name + ':' + p.notes.length + ' notes').join('  '))
console.log('first notes', JSON.stringify(sc.parts[0].notes.slice(0, 4)))
