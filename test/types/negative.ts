// Signature guard, negative half: every line below MUST fail to type-check.
//
// `@ts-expect-error` inverts the assertion. If one of these stops being an
// error — because a signature was loosened, a return type widened, or a method
// quietly gained an overload — TypeScript reports the directive itself as
// unused and `npm run typecheck` fails. That is the point: a guard that can
// only ever pass is not a guard.
//
// Keep each suppressed statement on ONE line. `@ts-expect-error` covers the
// next line only, so a wrapped statement would leave the tail unchecked.
import { Pixelblaze } from '../../lib/pixelblaze.mjs';

export async function everyOneOfTheseIsWrong() {
  const pb = new Pixelblaze('host');

  // getMap() with no args returns the source TEXT, not coordinates.
  // @ts-expect-error
  const notANumber: number = await pb.getMap();

  // ...but with coords:true it returns the coordinate array, not text.
  // @ts-expect-error
  const notAString: string = await pb.getMap({ coords: true });

  // sequencerMode is 0 Off / 1 ShuffleAll / 2 Playlist. There is no mode 5.
  // @ts-expect-error
  await pb.setSequencerMode(5);

  // Control values are numbers, or 3-element arrays for pickers. Never strings.
  // @ts-expect-error
  await pb.setControls({ sliderSpeed: 'not-a-number' });

  // Picker arrays are exactly 3 components.
  // @ts-expect-error
  await pb.setControls({ rgbPickerHours: [1, 0] });

  // No such method.
  // @ts-expect-error
  await pb.nope();

  // ping() reports latency in milliseconds.
  // @ts-expect-error
  const notMs: string = await pb.ping();

  // The constructor requires a host; the class resolves nothing itself.
  // @ts-expect-error
  new Pixelblaze();

  // Private internals must not be reachable through the declarations.
  // @ts-expect-error
  await pb._getConn();

  return { notANumber, notAString, notMs };
}
