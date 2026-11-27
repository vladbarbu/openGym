# How S stores weights, lengths and units

Research for issue #19 (map #18, the normalized Supabase schema). Every claim is backed by a line
in this repo. Paths are relative to the repo root, and `lib/` means `frontend/src/lib/`.

## Short answer

- **Weights are stored in the profile's unit (`S.unit`, `'kg'` by default), not canonical kg.**
  A kg/lb switch with "convert" on rewrites every stored weight, rounded to the plate grid of the
  new unit. That rounding is lossy. With "convert" off, only the label changes.
- **Inventories are kept per unit**: plates, dumbbells, bars and the weight step each live under
  a `kg` or `lb` key, and a switch never converts them. A machine stack keeps its own `unit`.
- **Speed, distance and lengths are canonical**: km/h, km and cm, whatever the display unit.
  Only the screen converts.
- **Custom measurements** are canonical (cm, kg to 0.001, %) and each reading also carries its
  unit.
- The server never converts anything. Conversion happens only on the client, during the 409
  merge.

## 1. Weights live in the profile unit

| Field | Where it is converted on a switch |
|---|---|
| sets `w`, drop `w`, side sets L/R | `lib/units.js:64-74` (mapSetWeights) |
| entry `topW`, `target`, `planned` | `lib/units.js:89-100` (mapEntryWeights) |
| routine slot `weight`, `warmup[].weight`, `pyramidWeight[]` | `lib/units.js:75-88` |
| routine slot `inc`, `backoffStep` (steps, not loads) | `lib/units.js:81-83`, via convertStep |
| `exWeights` (number or `{w}`) | `lib/units.js:160` |
| `barWeights` (per-exercise bar override) | `lib/units.js:161`, `:109-120` |
| `bodyweight[].w`, `bodyweight[].ins[].w`, `targetW`, session `bw` | `lib/units.js:146`, `:152-153` |
| `rateGoal.lo/hi` when `by === 'w'` | `lib/units.js:156-159` (to 0.01) |
| `active` (the running session) | `lib/units.js:170` |
| cached session `vol` | recomputed from the converted sets, `lib/units.js:147` |

- `lib/ex-unit.js:3-5`: "Every weight in state stays in the profile's unit (S.unit), so the
  workouts, the stats, the records, the sync, the API, the MCP server, the Coach and the CSV
  export read exactly the numbers they always read."
- `lib/sync-merge.js:49-50`: "Every weight in a copy is in its `unit`".
- The default is `unit: 'kg'` (`frontend/src/store/useStore.js:94`). The MCP server reports
  `S.unit` next to every number it returns (`mcp/src/tools.js:134`, `:300`) and does not
  convert.
- `log_workout` (MCP, API writers) converts its input into the profile unit, to 0.1
  (`lib/log-workout.js:168-177`).

### Per-exercise unit pin (#657)

`S.exUnit[id] = { unit, _ts }` makes one exercise show and accept the other unit. Storage stays in
the profile unit, converted exactly to **4 decimals** (`EXACT_STORE`) and shown to 3
(`EXACT_VIEW`): "45 lb on a kg profile is stored as 20.4117 kg and reads back as 45 lb"
(`lib/units.js:19-31`, `lib/ex-unit.js:9-16`). A value shown and saved without an edit keeps its
stored number (`lib/ex-unit.js:50-51`). So stored weights can carry 4 decimals, not just plate
values.

### Kept per unit, never converted

- `S.plates = { kg: {size: pairs, _ts}, lb: {...} }`, keyed by unit (`lib/plates.js:54-57`, `:82`).
  Built-in sizes: `lib/plates.js:21-24`.
- `S.dumbbells[unit] = { weights, _ts }` (`lib/dumbbells.js:25`, `:198`).
- `S.barDefaults = { kg: {...}, lb: {...} }` (`lib/bar.js:41`, `:48`).
- `S.wstep = { kg, lb }` (`lib/weight-step.js:3`, `:22-25`).
- The reason for all four: "a 45 lb plate does not become a 20.4 kg one" (`lib/units.js:162-167`).
- `S.stackWeights[exId] = { unit, weights, _ts }` records its own unit
  (`lib/dumbbells.js:30`, `:269`). Reading it in the other unit converts to 0.1
  (`lib/dumbbells.js:254-260`). It is the one weight list in S that labels its own values.
- In sync these are all stamped maps merged per key, so each unit's inventory is kept whole
  (`lib/sync-merge.js:39-41`, `:96`).

## 2. What a kg/lb switch does

`setUnit(to, { convert = true })` is in `frontend/src/store/useStore.js:1611-1624`.

- **convert on**: `convertStateUnit(S0, to)` (`lib/units.js:123-172`) walks every weight in the
  table above.
- **convert off**: `{ ...S0, unit: to }`. The numbers stay and only the label changes.
- Either way, it stamps `S.unitSet = { at: max(now, highestStamp + 1), convert }` and, on
  convert, pushes immediately (`useStore.js:1621-1623`).

Rounding used by the switch (`lib/units.js`):

| Converter | Rounding | Lines |
|---|---|---|
| convertWeight (loads) | to lb: nearest 0.5; to kg: nearest 0.25 | 12-17 |
| convertStep (`inc`, `backoffStep`) | paired steps (2.5 kg ↔ 5 lb, 0.1 kg ↔ 0.25 lb, ...), else exact to 0.01 | 32-42, 136 |
| convertExact (pinned exercise) | 4 decimals stored, 3 shown | 23-31, 130-133 |
| convertBodyWeight (`bodyweight`, `targetW`, `bw`) | nearest 0.1 | 50-57 |
| rateGoal | nearest 0.01 | 156-159 |
| bar override equal to the old unit's default bar | dropped, so the new unit's default takes over (45 lb → 20 kg) | 101-120 |

**The switch is lossy.** I checked this with node. Plate-grid kg values (multiples of 0.25)
survive kg → lb → kg (0 of 1,201 changed). Arbitrary 0.1 kg loads do not: 2,400 of 3,001 changed,
for example 62.3 kg → 137.5 lb → 62.25 kg. A table design can't recompute S's post-switch numbers
from canonical kg. They are what `convertWeight` produced.

### Merge-time conversion

- `lib/sync-merge.js:479-491` `inUnitOf(follow, lead)` brings one copy into the other's unit
  before anything is compared. It runs `convertStateUnit` (the same grid rounding), or only
  relabels when the lead's `unitSet.convert === false`.
- The lead is the copy with the later `unitSet.at`. On a tie, or with `prefer`, it is the
  preferred or newer side (`lib/sync-merge.js:851-862`).
- The rule is document-level: a whole copy is one unit (`lib/sync-merge.js:49-55`).
- `api/sync-stamps.js` lists `unit` and `unitSet` as its own merge keys
  (`api/sync-stamps.js:67-71`) and feeds `unitSet.at` into the stamp ceiling (`:112`). It never
  converts: the file has no conversion code. The server only stamps and returns 409. The client
  does the conversion.

## 3. Lengths, speed, distance, measurements

- **Body circumferences**: always stored in cm. The display unit is `S.measureUnit`, else
  in when the profile is lb (`lib/measurements.js:61-64`). Readings are rounded to **0.1** in
  their stored unit (`lib/measurements.js:47-50`), and display is also 0.1
  (`lib/measurements.js:67-71`).
- **Custom measurements**: `unit ∈ cm | in | % | kg | lb | none`
  (`lib/measurements.js:52`). Values are stored canonical:
  - cm for in, to 0.1
  - kg for lb, to **0.001** (`lib/measurements.js:50`, `:72-75`)
  - % from 0 to 100
  - a plain number for `none`

  Each reading also carries `unit` (`lib/measurements.js:104-111`). The CSV import converts in
  and lb columns back to cm and kg (`lib/measurements.js:223`).
- **Speed**: "stored in km/h, always". Only what is shown and typed follows `S.speedUnit`
  (`lib/speed.js:3-8`). A value typed in mph is stored in km/h to **0.01**. In km/h it is stored
  as typed, with no rounding (`lib/speed.js:31-38`).
- **Distance**: `km` is always kilometres. From miles it is stored to **0.0001** km and shown
  to 0.01 mi (`lib/distance.js:4-8`, `:30-31`). `KMH_PER_MPH = 1.609344` is exact
  (`lib/speed.js:12`).
- So switching the speed or length display rewrites nothing. Only weights are walked, "because
  a load has to land on plates in the unit you load; a speed does not" (`lib/speed.js:7-8`).

## 4. Precision the app relies on

| Thing | Precision | Source |
|---|---|---|
| Stored loads, general | whatever was typed, on the step grid. Pinned exercises: up to 4 dp | `lib/units.js:23-31` |
| Plate maths | quarter units (`Q = 4`): plate sums are whole multiples of 0.25 | `lib/plates.js:142-143` |
| Drop-set landing | owned dumbbells, else owned plates, else the exercise step | `lib/plates.js:286-303` |
| Weight steps offered | kg 0.1 to 5; lb 0.1 to 10 | `lib/weight-step.js:11-14` |
| Weight display | `S.wdec` 1 or 2 decimals, display only ("Nothing rounds differently in storage") | `lib/format.js:68-84`, `useStore.js:181` |
| Input fields | 2 dp; a value within 0.01 of the step or of a .5 is shown clean (44.996 → 45) | `lib/format.js:87-100` |
| Body weight | 0.1 in the profile unit | `lib/units.js:50-57` |
| Custom kg/lb measurements | 0.001 kg | `lib/measurements.js:50` |
| Lengths | 0.1 cm | `lib/measurements.js:47-50` |
| Speed | 0.01 km/h from mph | `lib/speed.js:35-38` |
| Distance | 0.0001 km from mi | `lib/distance.js:31` |

Round-trip check: a lb value stored as kg and read back. I ran this with node, using
`0.45359237` kg/lb exactly.

| lb precision | kg stored to | Mismatches |
|---|---|---|
| 0.01 lb, from 0 to 2,000 lb | 2 dp | 109,282 of 200,001 |
| 0.01 lb, from 0 to 2,000 lb | 3 dp | 0 |
| 0.1 lb, up to 4,000 lb | 1 dp | 21,857 |
| 0.1 lb, up to 4,000 lb | 2 dp | 0 |

So **3 dp of kg round-trips any lb value typed to the hundredth**, and the app itself uses 4
(`EXACT_STORE`).

## 5. Recommendation for the tables

**Store the value as S holds it, plus a `unit` column. Do not store canonical kg.**

Why:

1. S's numbers are not a function of canonical kg. After a switch they are `convertWeight`'s
   plate-snapped values (lossy, section 2), and after a "convert off" switch they are the old
   numbers under a new label. A canonical kg column would need a conversion on read that S
   never did, and it would show 61.235 kg where S holds 61.25. The adapter (rows to S and back)
   is only an identity if the rows hold S's numbers.
2. Today the unit is safe only because a whole document is one unit and the merge converts whole
   copies (`inUnitOf`). With per-row sync, a row pushed by an offline device still on kg can land
   after the switch to lb. A `unit` on the row makes it self-describing. The client then converts
   it on pull with `convertWeight` (the same rule as `inUnitOf`) and rewrites it. Without that
   column such a row is silently wrong.
3. S already labels its weight lists by unit (`plates[unit]`, `dumbbells[unit]`,
   `barDefaults[unit]`, `wstep[unit]`, `stackWeights[id].unit`). These become rows keyed by
   `(user_id, unit, ...)`, not converted values.
4. A switch with convert on still rewrites every weight-bearing row in the new unit, exactly as
   `convertStateUnit` does. Store `profile.unit` and `profile.unit_set_at` / `unit_set_convert`
   so a stale device can tell which side leads.

Columns:

- Weights (`sets.w`, drop weights, `routine_slots.weight`, warm-up and pyramid weights,
  `ex_weights.w`, `bar_weights.w`, plate sizes, dumbbell and stack weights):
  **`numeric(10,4)`**, plus `unit text check (unit in ('kg','lb'))`.
  - 4 dp matches `EXACT_STORE` (pinned exercises store 20.4117).
  - 3 dp is the floor for a lb hundredth to round-trip through kg.
  - 6 integer digits covers the 2,000 kg cap (`lib/log-workout.js:29`) in lb.
- Steps (`inc`, `backoffStep`, `wstep`): `numeric(8,4)` plus `unit`. Mode `time` reuses
  `inc` as seconds (`lib/units.js:81`), so the column needs the slot's mode beside it.
- Body weight (`weigh_ins.w`, `target_w`): `numeric(7,3)` plus `unit`. The app keeps 0.1, and
  3 dp leaves room for health-app imports.
- Canonical quantities with no unit column: `speed_kmh numeric(7,2)`, `km numeric(10,4)`, body
  lengths `numeric(6,1)` in cm, custom measurements `numeric(10,3)`. Custom measurements keep
  their own `unit` column, as S does per reading.
- Derived totals (`vol`, `topW`, decided as views in #18) sum rows of one unit. A view that mixes
  users or units must convert with a `CASE unit` at `0.45359237`.

If the map goes with canonical kg anyway, the minimum is `numeric(10,4)` kg (3 dp is the floor
for a lb hundredth). Every row also needs an `entered_unit`, and on read the client must round
back to the entered unit's grid. That puts the conversion rules of `lib/units.js` into the
adapter, the server and every view, when they live in one client file today.
