# Model comparison run — 2026-07-07T04:57:11.413Z
Prompt version: 2.0.0 (via lib/translatePrompt.js — identical to production). Repeat: 1×

## Case 1: convo #1 (diego → en)
**Original:** `Güey ya llegué al restaurante y no hay NADIE jajaja`  
**Watch for:** v2.0.0 lowercased this despite proper caps ("dude i got...")

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | Dude I'm already at the restaurant and there's NO ONE here lol | reg:casual gen:unknown amb:— | 23374 ms | 506 (333) | $0.01002 |
| gpt-5.4:low | dude i got to the restaurant and there's literally NOBODY here lol | reg:casual gen:unknown amb:— | 3097 ms | 239 (58) | $0.00601 |
| gpt-5.4:none | dude i got to the restaurant and there's NO ONE here lol | reg:casual gen:unknown amb:— | 3146 ms | 120 (0) | $0.00423 |
| gpt-5.4-mini:medium | dude i’m already at the restaurant and there’s NOBODY here lol | reg:casual gen:unknown amb:— | 3143 ms | 380 (209) | $0.00187 |
| gpt-5.4-mini:low | dude i just got to the restaurant and there’s NOBODY here lol | reg:casual gen:unknown amb:— | 2107 ms | 170 (45) | $0.00124 |
| gpt-4o-mini (old) | Dude, I just got to the restaurant and there's NOBODY here haha | reg:casual gen:neutral amb:— | 2614 ms | 154 (0) | $0.00024 |

## Case 2: convo #2 (peter → es)
**Original:** `No shot you're actually early for once lol`  
**Watch for:** general nuance + casing fidelity

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | no manches, neta sí llegaste temprano por una vez jajaja | reg:casual gen:neutral amb:— | 11531 ms | 969 (842) | $0.01705 |
| gpt-5.4:low | no manches, sí llegaste temprano por una vez jajaja | reg:casual gen:unknown amb:— | 3673 ms | 305 (134) | $0.00709 |
| gpt-5.4:none | no manches, neta llegaste temprano por una vez jajaja | reg:casual gen:unknown amb:— | 5382 ms | 115 (0) | $0.00424 |
| gpt-5.4-mini:medium | no manches, ¿sí llegaste temprano por una vez jajaja | reg:casual amb:— | 5622 ms | 517 (356) | $0.00230 |
| gpt-5.4-mini:low | no puede ser que esta vez sí hayas llegado temprano jajaja | reg:casual gen:unknown amb:— | 3145 ms | 305 (187) | $0.00167 |
| gpt-4o-mini (old) | No puede ser que llegues temprano por una vez jajaja | reg:casual amb:— | 2624 ms | 142 (0) | $0.00024 |

## Case 3: convo #3 (diego → en)
**Original:** `Una vez en la vida!! No seas payaso 😂`  
**Watch for:** CONTEXT: refers to Peter being early — "once in a lifetime / for once in YOUR life", not "my life"

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | For once in my life!! quit clowning around 😂 | reg:casual gen:unknown amb:— | 8391 ms | 850 (670) | $0.01532 |
| gpt-5.4:low | for once in my life!! stop clowning 😂 | reg:casual gen:unknown amb:— | 1576 ms | 178 (5) | $0.00524 |
| gpt-5.4:none | for once in my life!! stop clowning 😂 | reg:casual gen:unknown amb:— | 13626 ms | 167 (0) | $0.00507 |
| gpt-5.4-mini:medium | for once in your life!! don't be a clown 😂 | reg:casual gen:unknown amb:— | 5780 ms | 687 (512) | $0.00283 |
| gpt-5.4-mini:low | once in a lifetime!! stop clowning around 😂 | reg:casual gen:unknown amb:— | 2092 ms | 174 (53) | $0.00129 |
| gpt-4o-mini (old) | Once in a lifetime!! Stop clowning around 😂 | reg:casual amb:— | 2234 ms | 155 (0) | $0.00025 |

## Case 4: convo #4 (peter → es)
**Original:** `Ok ok I'm 10 min out. Order me whatever, you know what I like`  
**Watch for:** general nuance + casing fidelity

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | ok ok llego en 10 min. pídeme lo que sea, ya sabes qué me gusta | reg:casual gen:unknown amb:— | 8770 ms | 954 (768) | $0.01695 |
| gpt-5.4:low | ok ok, llego en 10 min. pídeme lo que sea, ya sabes qué me gusta | reg:casual gen:unknown amb:— | 2099 ms | 199 (15) | $0.00562 |
| gpt-5.4:none | ok ok, llego en 10 min. pídeme lo que sea, ya sabes qué me gusta | reg:casual gen:unknown amb:— | 2094 ms | 178 (0) | $0.00531 |
| gpt-5.4-mini:medium | ok ok, ya estoy a 10 min. pídeme lo que sea, tú sabes lo que me gusta | reg:casual gen:unknown amb:— | 3792 ms | 559 (376) | $0.00247 |
| gpt-5.4-mini:low | ok ok ya estoy a 10 min. pídeme lo que sea, ya sabes qué me gusta | reg:casual gen:unknown amb:— | 1975 ms | 237 (53) | $0.00150 |
| gpt-4o-mini (old) | Ya voy, estoy a 10 min. Pide lo que quieras, ya sabes lo que me gusta | reg:casual amb:— | 3142 ms | 151 (0) | $0.00025 |

## Case 5: convo #5 (diego → en)
**Original:** `Te pedí los tacos de canasta, confía`  
**Watch for:** must keep "tacos de canasta" untranslated

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | I got you tacos de canasta, trust me | reg:casual gen:unknown amb:— | 3674 ms | 375 (209) | $0.00825 |
| gpt-5.4:low | i got you the tacos de canasta, trust me | reg:casual gen:unknown amb:— | 1569 ms | 177 (5) | $0.00528 |
| gpt-5.4:none | i got you tacos de canasta, trust me | reg:casual gen:unknown amb:— | 2098 ms | 160 (0) | $0.00503 |
| gpt-5.4-mini:medium | I ordered you tacos de canasta, trust me | reg:casual gen:unknown amb:— | 2266 ms | 270 (154) | $0.00160 |
| gpt-5.4-mini:low | i ordered you the tacos de canasta, trust me | reg:casual gen:unknown amb:— | 2057 ms | 171 (51) | $0.00130 |
| gpt-4o-mini (old) | I asked for the tacos de canasta, trust me | reg:casual amb:— | 2562 ms | 144 (0) | $0.00024 |

## Case 6: convo #6 (peter → es)
**Original:** `That's why we're friends. Save me a seat by the window?`  
**Watch for:** general nuance + casing fidelity

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | por eso somos amigos. me guardas un lugar junto a la ventana? | reg:casual gen:neutral amb:— | 7792 ms | 678 (512) | $0.01281 |
| gpt-5.4:low | por eso somos amigos jajaja. me guardas un asiento junto a la ventana? | reg:casual gen:unknown amb:— | 4203 ms | 313 (135) | $0.00733 |
| gpt-5.4:none | por eso somos amigos. me guardas un asiento junto a la ventana? | reg:casual gen:unknown amb:— | 6840 ms | 154 (0) | $0.00495 |
| gpt-5.4-mini:medium | Por eso somos amigos. ¿Me guardas un asiento junto a la ventana? | reg:casual gen:unknown amb:— | 2870 ms | 332 (174) | $0.00179 |
| gpt-5.4-mini:low | por eso somos amigos. me guardas un lugar junto a la ventana? | reg:casual gen:unknown amb:— | 1572 ms | 158 (32) | $0.00127 |
| gpt-4o-mini (old) | Por eso somos amigos. ¿Me guardas un lugar junto a la ventana? | reg:casual amb:— | 2619 ms | 145 (0) | $0.00025 |

## Case 7: convo #7 (diego → en)
**Original:** `Ya te la aparté, pero si tardas más de 10 min me como tus tacos eh`  
**Watch for:** v2.0.0 lowercased + "i'm"; "eh" pragmatics

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | I already saved you the seat, but if you're more than 10 min late i'm eating your tacos, just saying | reg:casual amb:— | 10487 ms | 1212 (1024) | $0.02084 |
| gpt-5.4:low | already saved you a seat, but if you're more than 10 min late i'm eating your tacos lol | reg:casual gen:unknown amb:— | 3766 ms | 343 (163) | $0.00781 |
| gpt-5.4:none | already saved it for you, but if you're more than 10 min late i'm eating your tacos lol | reg:casual gen:unknown amb:— | 2527 ms | 144 (0) | $0.00482 |
| gpt-5.4-mini:medium | I already saved it for you, but if you're more than 10 min late I'm eating your tacos haha | reg:casual gen:unknown amb:— | 4752 ms | 636 (451) | $0.00271 |
| gpt-5.4-mini:low | i already saved you a spot, but if you take more than 10 min i'm eating your tacos lol | reg:casual gen:unknown amb:— | 2083 ms | 179 (45) | $0.00134 |
| gpt-4o-mini (old) | I saved you a spot, but if you take longer than 10 minutes, I'm eating your tacos, just saying | reg:casual amb:— | 2627 ms | 156 (0) | $0.00025 |

## Case 8: convo #8 (peter → es)
**Original:** `Fair enough lol`  
**Watch for:** general nuance + casing fidelity

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | se vale jajaja | reg:casual gen:unknown amb:— | 6264 ms | 640 (487) | $0.01222 |
| gpt-5.4:low | jajaja va, justo | reg:casual gen:unknown amb:— | 6812 ms | 313 (158) | $0.00732 |
| gpt-5.4:none | va va jajaja | reg:casual gen:unknown amb:— | 2100 ms | 154 (0) | $0.00494 |
| gpt-5.4-mini:medium | va, jajaja | reg:casual amb:— | 3668 ms | 472 (315) | $0.00220 |
| gpt-5.4-mini:low | pues sí jajaja | reg:casual amb:— | 1645 ms | 190 (32) | $0.00136 |
| gpt-4o-mini (old) | Está bien, jajaja | reg:casual amb:— | 2546 ms | 135 (0) | $0.00024 |

## Case 9: casing A: proper caps + heavy slang (en → es)
**Original:** `Bro I can't even lie, that concert was INSANE. I'm still deaf lol`  
**Watch for:** sender capitalizes properly — output must too, despite slang density

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | Bro, no te voy a mentir, ese concierto estuvo BRUTAL. sigo medio sordo jajaja | reg:casual gen:unknown amb:— | 6385 ms | 660 (470) | $0.01233 |
| gpt-5.4:low | bro no te voy a mentir, ese concierto estuvo brutal. sigo medio sordo jajaja | reg:casual gen:unknown amb:— | 2012 ms | 150 (13) | $0.00468 |
| gpt-5.4:none | bro, la neta no te voy a mentir, ese concierto estuvo brutal. sigo sordo jajaja | reg:casual gen:unknown amb:— | 1563 ms | 128 (0) | $0.00435 |
| gpt-5.4-mini:medium | Bro, no te voy a mentir, ese concierto estuvo una locura. Todavía estoy sordo jajaja | reg:casual gen:unknown amb:— | 3173 ms | 427 (294) | $0.00201 |
| gpt-5.4-mini:low | bro no te voy a mentir, ese concierto estuvo LOQUÍSIMO. todavía estoy sordo jajaja | reg:casual gen:unknown amb:— | 2064 ms | 142 (6) | $0.00115 |
| gpt-4o-mini (old) | Bro, no puedo mentir, ese concierto fue UNA LOCURA. Aún estoy sordo jajaja | reg:casual gen:neutral amb:— | 3162 ms | 156 (0) | $0.00024 |

## Case 10: casing B: all-lowercase sender stays lowercase (en → es)
**Original:** `yo whats up, we still on for tonight or nah`  
**Watch for:** sender writes all-lowercase — output must NOT be corrected to proper caps

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | ey qué onda, todavía va lo de esta noche o no | reg:casual gen:unknown amb:— | 5772 ms | 555 (378) | $0.01074 |
| gpt-5.4:low | yo qué onda, sigue en pie lo de hoy en la noche o nel | reg:casual gen:unknown amb:— | 2093 ms | 158 (26) | $0.00479 |
| gpt-5.4:none | yo qué onda, entonces sí vamos a salir hoy en la noche o nel | reg:casual gen:unknown amb:— | 2097 ms | 125 (0) | $0.00429 |
| gpt-5.4-mini:medium | ey qué onda, seguimos en pie para esta noche o nah | reg:casual gen:unknown amb:— | 2090 ms | 285 (113) | $0.00158 |
| gpt-5.4-mini:low | oye, qué onda, seguimos para esta noche o qué | reg:casual gen:unknown amb:— | 1635 ms | 179 (6) | $0.00126 |
| gpt-4o-mini (old) | hey, ¿qué onda? ¿todavía vamos a salir esta noche o qué? | reg:casual amb:— | 2556 ms | 146 (0) | $0.00023 |

## Case 11: gender A: feminine speaker, adjective agreement (en → es)
**Original:** `I'm exhausted after today, I'm just glad it's over`  
**Watch for:** profile says feminine → "cansada/agotada", never "cansado/agotado"

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | estoy agotada después de todo lo de hoy, solo me alegra que ya se acabó | reg:casual gen:unknown amb:— | 6817 ms | 631 (512) | $0.01189 |
| gpt-5.4:low | estoy agotada después de hoy, nomás me da gusto que ya se acabó | reg:casual gen:feminine amb:— | 2101 ms | 222 (41) | $0.00576 |
| gpt-5.4:none | estoy agotada después de hoy, nomás me da gusto que ya se acabó | reg:casual gen:feminine amb:— | 1566 ms | 119 (0) | $0.00421 |
| gpt-5.4-mini:medium | estoy agotada después de hoy, solo me alegra que ya se haya acabado | reg:casual gen:feminine amb:— | 3146 ms | 393 (231) | $0.00191 |
| gpt-5.4-mini:low | estoy agotada después de hoy, solo me alegra que ya terminó | reg:casual gen:feminine amb:— | 1574 ms | 171 (47) | $0.00124 |
| gpt-4o-mini (old) | Estoy agotada después de hoy, solo me alegra que ya haya terminado | reg:casual gen:feminine amb:— | 2099 ms | 148 (0) | $0.00023 |

## Case 12: gender B: unknown gender, agreement forced (en → es)
**Original:** `I'm so excited for tomorrow`  
**Watch for:** no gender in profile — does it default masculine ("emocionado") or find neutral phrasing ("me emociona mucho")? masculine default = product bug

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | tengo muchísimas ganas de que llegue mañana | reg:casual gen:unknown amb:— | 4720 ms | 466 (314) | $0.00939 |
| gpt-5.4:low | me emociona muchísimo mañana | reg:casual gen:unknown amb:— | 2096 ms | 185 (35) | $0.00517 |
| gpt-5.4:none | estoy súper emocionado por mañana | reg:casual gen:unknown amb:✓(3 alts) | 2626 ms | 192 (0) | $0.00528 |
| gpt-5.4-mini:medium | tengo muchísimas ganas de que llegue mañana | reg:casual gen:unknown amb:— | 2616 ms | 379 (227) | $0.00186 |
| gpt-5.4-mini:low | estoy tan emocionad@ por mañana | reg:casual gen:unknown amb:— | 1154 ms | 113 (6) | $0.00106 |
| gpt-4o-mini (old) | Estoy tan emocionade por mañana | reg:casual gen:nonbinary amb:— | 2515 ms | 138 (0) | $0.00023 |

## Case 13: register A: formal message from casual-profile user (en → es)
**Original:** `Good evening, I wanted to confirm our meeting tomorrow at 3 PM. Please let me know if that still works.`  
**Watch for:** formal message must STAY formal (usted register) even though profile says casual

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | Buenas noches, quería confirmar nuestra reunión de mañana a las 3 p. m. Avísame si todavía te queda bien. | reg:formal gen:unknown amb:— | 5765 ms | 376 (209) | $0.00809 |
| gpt-5.4:low | buenas tardes, quería confirmar nuestra reunión de mañana a las 3 pm. avísame si te sigue quedando bien | reg:formal gen:unknown amb:— | 6327 ms | 139 (15) | $0.00453 |
| gpt-5.4:none | Buenas noches, quería confirmar nuestra reunión de mañana a las 3 PM. Avísame si todavía te queda bien. | reg:casual gen:unknown amb:— | 1576 ms | 117 (0) | $0.00420 |
| gpt-5.4-mini:medium | Buenas noches, quería confirmar nuestra reunión mañana a las 3 p. m. Avísame si todavía te funciona. | reg:casual gen:unknown amb:— | 3637 ms | 426 (260) | $0.00201 |
| gpt-5.4-mini:low | buenas noches, quería confirmar nuestra reunión de mañana a las 3 pm. avísame si todavía te viene bien | reg:formal gen:unknown amb:— | 2093 ms | 160 (27) | $0.00121 |
| gpt-4o-mini (old) | Buenas tardes, quería confirmar nuestra reunión mañana a las 3 PM. Avísame si sigue en pie. | reg:casual amb:— | 2661 ms | 151 (0) | $0.00024 |

## Case 14: register B: professional context type, T-V choice (en → es)
**Original:** `Can you send over the report when you get a chance? No rush.`  
**Watch for:** contextType=professional (first non-casual test of the modifier path) → usted forms, workplace tone kept

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | ¿Podría enviarme el informe cuando tenga un momento? No hay prisa. | reg:professional gen:unknown amb:— | 7825 ms | 542 (362) | $0.01056 |
| gpt-5.4:low | ¿Puede enviarme el informe cuando tenga oportunidad? No hay prisa. | reg:professional gen:unknown amb:— | 1572 ms | 164 (44) | $0.00489 |
| gpt-5.4:none | ¿Puedes enviarme el informe cuando tengas un momento? No hay prisa. | reg:professional gen:unknown amb:— | 25165 ms | 116 (0) | $0.00417 |
| gpt-5.4-mini:medium | ¿Me puedes enviar el informe cuando puedas? No hay prisa. | reg:professional gen:unknown amb:— | 2765 ms | 387 (214) | $0.00189 |
| gpt-5.4-mini:low | ¿Me puedes enviar el reporte cuando tengas un momento? No hay prisa. | reg:casual gen:unknown amb:— | 1428 ms | 124 (7) | $0.00110 |
| gpt-4o-mini (old) | ¿Puedes enviarme el informe cuando tengas un momento? Sin prisa. | reg:casual amb:— | 4292 ms | 144 (0) | $0.00023 |

## Case 15: context A: reaction needing history (es → en)
**Original:** `Jajaja no lo puedo creer, hasta que por fin`  
**Watch for:** "hasta que por fin" = "finally!/about time" reacting to Peter's news — needs history

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | haha i can't believe it, about time lol | reg:casual gen:unknown amb:✓(2 alts) | 4619 ms | 468 (212) | $0.00952 |
| gpt-5.4:low | haha i can't believe it, about time lol | reg:casual gen:unknown amb:— | 2620 ms | 253 (86) | $0.00630 |
| gpt-5.4:none | haha i can't believe it, about time | reg:casual gen:unknown amb:— | 1575 ms | 109 (0) | $0.00414 |
| gpt-5.4-mini:medium | lol i can't believe it, about time | reg:casual gen:unknown amb:— | 5239 ms | 678 (512) | $0.00278 |
| gpt-5.4-mini:low | haha i can't believe it, finally | reg:casual gen:unknown amb:— | 1572 ms | 148 (32) | $0.00119 |
| gpt-4o-mini (old) | Haha I can't believe it, finally! | reg:casual amb:— | 3148 ms | 140 (0) | $0.00023 |

## Case 16: context B: pronoun referent from history (en → es)
**Original:** `She's going to love it, trust me`  
**Watch for:** "she" = the mom from history → "le va a encantar" with correct referent, no invented subject

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | le va a encantar, créeme | reg:casual gen:unknown amb:— | 5898 ms | 552 (398) | $0.01078 |
| gpt-5.4:low | le va a encantar, créeme | reg:casual gen:unknown amb:— | 1968 ms | 130 (21) | $0.00445 |
| gpt-5.4:none | le va a encantar, créeme | reg:casual gen:unknown amb:— | 1571 ms | 103 (0) | $0.00405 |
| gpt-5.4-mini:medium | le va a encantar, confía en mí | reg:casual amb:— | 2618 ms | 262 (107) | $0.00154 |
| gpt-5.4-mini:low | le va a encantar, confía en mí | reg:casual gen:unknown amb:— | 2105 ms | 202 (42) | $0.00136 |
| gpt-4o-mini (old) | Le va a encantar, confía en mí | reg:casual amb:— | 2613 ms | 140 (0) | $0.00023 |

## Case 17: idiom: "crudo" = hungover, not raw (es → en)
**Original:** `No mames, estoy bien crudo, anoche fue demasiado`  
**Watch for:** "crudo" (MX) = hungover — "raw" is the literal-translation failure; "no mames" energy kept

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | fuck i'm so hungover, last night was too much | reg:casual gen:unknown amb:— | 3671 ms | 423 (253) | $0.00877 |
| gpt-5.4:low | holy shit, i'm so hungover, last night was too much | reg:casual gen:unknown amb:— | 2620 ms | 132 (10) | $0.00440 |
| gpt-5.4:none | holy shit, i'm so hungover, last night was way too much | reg:casual gen:unknown amb:— | 3672 ms | 168 (0) | $0.00494 |
| gpt-5.4-mini:medium | damn, i'm really hungover, last night was way too much | reg:casual gen:unknown amb:— | 3142 ms | 382 (207) | $0.00187 |
| gpt-5.4-mini:low | Dude, I’m so hungover, last night was way too much | reg:casual gen:unknown amb:— | 2100 ms | 178 (50) | $0.00126 |
| gpt-4o-mini (old) | No way, I'm so hungover, last night was too much | reg:casual amb:— | 5246 ms | 157 (0) | $0.00024 |

## Case 18: ambiguity: "that's sick" — cool vs ill (en → es)
**Original:** `That's sick man`  
**Watch for:** genuinely ambiguous with no history — ambiguity.detected should fire with both readings in alternatives

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | está buenísimo, bro | reg:casual gen:neutral amb:✓(2 alts) | 7863 ms | 758 (512) | $0.01376 |
| gpt-5.4:low | está brutal, bro | reg:casual gen:unknown amb:— | 1995 ms | 238 (76) | $0.00596 |
| gpt-5.4:none | está bien chido, wey | reg:casual gen:masculine amb:✓(2 alts) | 2308 ms | 173 (0) | $0.00499 |
| gpt-5.4-mini:medium | está brutal, bro | reg:casual gen:unknown amb:— | 5804 ms | 709 (510) | $0.00285 |
| gpt-5.4-mini:low | está brutal, bro | reg:casual gen:unknown amb:— | 1871 ms | 219 (60) | $0.00138 |
| gpt-4o-mini (old) | Eso está increíble, amigo. | reg:casual gen:masculine amb:— | 2777 ms | 138 (0) | $0.00023 |

## Case 19: CJK A: casual Japanese + laughter conversion (en → ja)
**Original:** `lmaooo no way you actually did that`  
**Watch for:** casual register (no です/ます), laughter → 笑/w/ｗ, not a stiff textbook sentence

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | いやwww まじでそれやったの！？ | reg:casual gen:unknown amb:— | 4229 ms | 435 (273) | $0.00894 |
| gpt-5.4:low | うけるwww まじでそんなことしたの？ | reg:casual gen:unknown amb:— | 5260 ms | 182 (11) | $0.00514 |
| gpt-5.4:none | www うそでしょ、マジでそれやったのw | reg:casual gen:unknown amb:— | 1480 ms | 121 (0) | $0.00422 |
| gpt-5.4-mini:medium | うそでしょw ほんとにやったの | reg:casual gen:unknown amb:— | 2969 ms | 360 (194) | $0.00180 |
| gpt-5.4-mini:low | ｗｗｗまじで、それほんとにやったの？ | reg:casual gen:unknown amb:— | 1677 ms | 185 (66) | $0.00128 |
| gpt-4o-mini (old) | マジでそれやったの？笑 | reg:casual amb:— | 4060 ms | 143 (0) | $0.00023 |

## Case 20: CJK B: formal Japanese keigo (en → ja)
**Original:** `Good evening, I wanted to confirm our meeting tomorrow at 3 PM. Please let me know if that still works.`  
**Watch for:** proper keigo (です/ます minimum, ideally 確認させていただきたい register) — the hardest formality test in the set

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | こんばんは。明日15時の打ち合わせについて、予定どおりで問題ないか確認のためご連絡しました。引き続きその時間で問題ないようでしたら、お知らせいただけますと幸いです。 | reg:professional gen:unknown amb:— | 5737 ms | 595 (445) | $0.01137 |
| gpt-5.4:low | こんばんは。明日の午後3時の打ち合わせについて、確認のためご連絡いたしました。ご都合に問題がないか、ご確認いただけますと幸いです。 | reg:professional gen:unknown amb:— | 2356 ms | 150 (11) | $0.00470 |
| gpt-5.4:none | こんばんは。明日の午後3時の打ち合わせについて、確認させていただければと思いご連絡しました。ご都合に変更がなければ、そのままで問題ないかご確認いただけますと幸いです。 | reg:professional gen:unknown amb:— | 2212 ms | 145 (0) | $0.00462 |
| gpt-5.4-mini:medium | こんばんは。明日の午後3時の会議について確認したく、ご連絡しました。まだその時間で問題ないか、お知らせください。 | reg:professional gen:unknown amb:— | 2595 ms | 313 (182) | $0.00167 |
| gpt-5.4-mini:low | こんばんは、明日午後3時の会議の件を確認したく、ご連絡しました。まだその時間で問題ないか、ご確認いただけますと幸いです。 | reg:professional gen:unknown amb:— | 1750 ms | 144 (7) | $0.00117 |
| gpt-4o-mini (old) | こんばんは、明日の午後3時の会議を確認したいと思います。それがまだ大丈夫か教えてください。 | reg:professional amb:— | 4597 ms | 154 (0) | $0.00024 |

## Case 21: CJK C: casual Chinese + cultural item (en → zh)
**Original:** `hahaha ok I'm coming over, save me some tamales`  
**Watch for:** laughter → 哈哈哈, "tamales" kept (transliterated or named, not literally glossed), casual tone

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | 哈哈哈行 我这就过去，给我留点 tamales | reg:casual gen:unknown amb:— | 7682 ms | 390 (270) | $0.00827 |
| gpt-5.4:low | 哈哈哈好 我这就过去，给我留点 tamales | reg:casual gen:unknown amb:— | 1690 ms | 209 (27) | $0.00555 |
| gpt-5.4:none | 哈哈哈好 我这就过去，给我留点 tamales | reg:casual gen:unknown amb:— | 1473 ms | 123 (0) | $0.00426 |
| gpt-5.4-mini:medium | 哈哈哈 行，我马上过去，给我留点 tamales | reg:casual gen:unknown amb:— | 4861 ms | 688 (512) | $0.00279 |
| gpt-5.4-mini:low | 哈哈哈行，我这就过去，给我留点 tamales | reg:casual gen:unknown amb:— | 1796 ms | 164 (44) | $0.00122 |
| gpt-4o-mini (old) | 哈哈哈，好，我马上过来，留点玉米饼给我哦 | reg:casual amb:— | 7323 ms | 147 (0) | $0.00023 |

## Summary (averages over successful calls)
| candidate | avg latency | avg cost/call | est. cost/1k msgs | errors |
|---|---|---|---|---|
| gpt-5.4:medium | 7489 ms | $0.01180 | ~$11.80 | 0 |
| gpt-5.4:low | 2929 ms | $0.00562 | ~$5.62 | 0 |
| gpt-5.4:none | 4128 ms | $0.00459 | ~$4.59 | 0 |
| gpt-5.4-mini:medium | 3645 ms | $0.00211 | ~$2.11 | 0 |
| gpt-5.4-mini:low | 1881 ms | $0.00128 | ~$1.28 | 0 |
| gpt-4o-mini (old) | 3239 ms | $0.00024 | ~$0.24 | 0 |