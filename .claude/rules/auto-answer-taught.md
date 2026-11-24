# Taught answers — rules the operator taught from the question relay

Every agent session in this project loads this file. Each entry is a question an agent asked,
the answer the operator taught for it, and — when given — the condition or reason. Apply an
entry only when its condition holds; otherwise ask as usual. The auto-answer decider reads this
file too and answers such a question on the operator's behalf. Edit or delete entries here by
hand; new ones are appended from the fleet's question-relay panel.

## Mindhárom kérésed éles vagy út közben van (pusholva, 0b9a084, 226/226 zöld):

- **Question:** Mindhárom kérésed éles vagy út közben van (pusholva, 0b9a084, 226/226 zöld):
  • 300k-s határ: 40 fában működik (`floor 300000`). Egy kézzel karbantartott fogyasztó watchere régebbi a warm-idle-nél, ott nem működik.
  • Handoff költség: minden clear után `cost` sor kerül a logba, 20 kéréssel később `payback` sor (mennyit spórolt, nettó eredmény). A ma reggeli clear 0,92M egyenérték volt, 80%-a a kihűlt cache újraírása.
  • Kihűlés miatti clear után a folytatás „WAITING FOR THE USER” felirattal indul, a session nem kezd dolgozni, csak megírja egy NEED INPUT: sorban, mire várt.
  A másolatos fákba a set-core rollolja (kérve). Ha válaszolnak, ellenőrzöm, és az első valódi cost sort megmutatom. Mehet így, vagy legyen a felirat magyarul (pl. „FELHASZNÁLÓRA VÁRTAM”)?
- **Answer:** Mehet angolul (Recommended)
- **When / why:** false alarm, a mechanizmus már él vagy most lett megcsinálva  és most mi csak egy részletről döntünk még vele kapcsolatban, pl itt esetünkben hogy magyar vagy angol szöveg legyen. erre nem kell megerősítés mehet automatikusan
- *Taught 2026-11-24 from the question relay.*
