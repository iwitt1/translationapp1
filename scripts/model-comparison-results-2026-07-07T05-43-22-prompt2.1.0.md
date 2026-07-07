# Model comparison run — 2026-07-07T05:31:13.584Z
Prompt version: 2.1.0 (via lib/translatePrompt.js — identical to production). Repeat: 1×

## Case 1: convo #1 (diego → en)
**Original:** `Güey ya llegué al restaurante y no hay NADIE jajaja`  
**Watch for:** v2.0.0 lowercased this despite proper caps ("dude i got...")

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | Dude I’m already at the restaurant and there’s NOBODY here lol | reg:casual gen:unknown amb:— | 5840 ms | 517 (341) | $0.01071 |
| gpt-5.4:low | Dude I’m already at the restaurant and there’s NOBODY here lol | reg:casual gen:unknown amb:— | 15209 ms | 183 (7) | $0.00570 |
| gpt-5.4:none | Dude I already got to the restaurant and there's NO ONE here lol | reg:casual gen:unknown amb:— | 2607 ms | 124 (0) | $0.00482 |
| gpt-5.4-mini:medium | Dude I just got to the restaurant and there's NOBODY here lol | reg:casual gen:unknown amb:— | 5359 ms | 620 (445) | $0.00275 |
| gpt-5.4-mini:low | Dude, I just got to the restaurant and there’s NOBODY here lol | reg:casual gen:unknown amb:— | 1977 ms | 179 (54) | $0.00142 |
| gpt-4o-mini (old) | Dude, I just got to the restaurant and there's NOBODY here haha | reg:casual gen:neutral amb:— | 2624 ms | 154 (0) | $0.00027 |

## Case 2: convo #2 (peter → es)
**Original:** `No shot you're actually early for once lol`  
**Watch for:** general nuance + casing fidelity

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | No manches que sí llegaste temprano por una vez jajaja | reg:casual gen:unknown amb:— | 14201 ms | 669 (506) | $0.01308 |
| gpt-5.4:low | No manches, ¿neta llegaste temprano por una vez? jajaja | reg:casual gen:unknown amb:— | 5718 ms | 329 (152) | $0.00798 |
| gpt-5.4:none | No manches que de verdad llegaste temprano por una vez jajaja | reg:casual gen:unknown amb:— | 2100 ms | 115 (0) | $0.00477 |
| gpt-5.4-mini:medium | No puede ser que de verdad hayas llegado temprano por una vez jaja | reg:casual gen:unknown amb:— | 5242 ms | 634 (512) | $0.00281 |
| gpt-5.4-mini:low | No puede ser que de verdad hayas llegado temprano por una vez jajaja | reg:casual gen:unknown amb:— | 2628 ms | 277 (160) | $0.00174 |
| gpt-4o-mini (old) | No puede ser que llegues temprano por una vez jajaja | reg:casual amb:— | 3135 ms | 142 (0) | $0.00027 |

## Case 3: convo #3 (diego → en)
**Original:** `Una vez en la vida!! No seas payaso 😂`  
**Watch for:** CONTEXT: refers to Peter being early — "once in a lifetime / for once in YOUR life", not "my life"

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | For once in my life!! Stop clowning 😂 | reg:casual gen:unknown amb:✓(2 alts) | 31605 ms | 703 (512) | $0.01364 |
| gpt-5.4:low | For once in your life!! Stop clowning 😂 | reg:casual gen:unknown amb:— | 3148 ms | 320 (147) | $0.00790 |
| gpt-5.4:none | For once in your life!! Stop clowning around 😂 | reg:casual gen:unknown amb:— | 1698 ms | 168 (0) | $0.00562 |
| gpt-5.4-mini:medium | For once in your life!! Stop clowning around 😂 | reg:casual gen:unknown amb:— | 4591 ms | 686 (512) | $0.00299 |
| gpt-5.4-mini:low | Once in a lifetime!! Don't be ridiculous 😂 | reg:casual gen:unknown amb:✓(2 alts) | 2208 ms | 286 (83) | $0.00179 |
| gpt-4o-mini (old) | Once in a lifetime!! Stop clowning around 😂 | reg:casual amb:— | 2609 ms | 155 (0) | $0.00028 |

## Case 4: convo #4 (peter → es)
**Original:** `Ok ok I'm 10 min out. Order me whatever, you know what I like`  
**Watch for:** general nuance + casing fidelity

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | Ok ok llego en 10 min. Pídeme lo que sea, ya sabes qué me gusta | reg:casual gen:unknown amb:— | 5168 ms | 532 (397) | $0.01115 |
| gpt-5.4:low | Ok ok llego en 10 min. Pídeme lo que sea, ya sabes lo que me gusta | reg:casual gen:unknown amb:— | 3117 ms | 340 (161) | $0.00827 |
| gpt-5.4:none | Ok ok llego en 10 min. Pídeme lo que sea, ya sabes qué me gusta | reg:casual gen:unknown amb:— | 2628 ms | 123 (0) | $0.00501 |
| gpt-5.4-mini:medium | Ok ok estoy a 10 min. Pídeme lo que quieras, ya sabes lo que me gusta | reg:casual gen:unknown amb:— | 6852 ms | 471 (337) | $0.00236 |
| gpt-5.4-mini:low | Ok ok estoy a 10 min. Pídeme lo que sea, ya sabes qué me gusta | reg:casual gen:unknown amb:— | 2579 ms | 277 (89) | $0.00178 |
| gpt-4o-mini (old) | Ok ok, ya voy en 10 minutos. Pídeme lo que sea, ya sabes lo que me gusta | reg:casual amb:— | 2650 ms | 153 (0) | $0.00028 |

## Case 5: convo #5 (diego → en)
**Original:** `Te pedí los tacos de canasta, confía`  
**Watch for:** must keep "tacos de canasta" untranslated

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | I ordered you the tacos de canasta, trust me | reg:casual gen:unknown amb:— | 3641 ms | 337 (217) | $0.00821 |
| gpt-5.4:low | I got you the tacos de canasta, trust me | reg:casual gen:unknown amb:— | 31977 ms | 125 (5) | $0.00503 |
| gpt-5.4:none | I ordered you tacos de canasta, trust me | reg:casual gen:unknown amb:— | 1600 ms | 165 (0) | $0.00563 |
| gpt-5.4-mini:medium | I got you the tacos de canasta, trust me | reg:casual gen:unknown amb:— | 3646 ms | 396 (228) | $0.00214 |
| gpt-5.4-mini:low | I ordered the tacos de canasta for you, trust me | reg:casual gen:unknown amb:— | 2151 ms | 275 (102) | $0.00177 |
| gpt-4o-mini (old) | I asked for the tacos de canasta, trust me | reg:casual amb:— | 4141 ms | 144 (0) | $0.00028 |

## Case 6: convo #6 (peter → es)
**Original:** `That's why we're friends. Save me a seat by the window?`  
**Watch for:** general nuance + casing fidelity

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | Por eso somos amigos. Me guardas un lugar junto a la ventana? | reg:casual gen:unknown amb:— | 36702 ms | 1018 (888) | $0.01844 |
| gpt-5.4:low | Por eso somos amigos. Me guardas un lugar junto a la ventana? | reg:casual gen:unknown amb:— | 4358 ms | 353 (196) | $0.00846 |
| gpt-5.4:none | Por eso somos amigos. ¿Me guardas un asiento junto a la ventana? | reg:casual gen:unknown amb:— | 6121 ms | 124 (0) | $0.00503 |
| gpt-5.4-mini:medium | Por eso somos amigos. ¿Me guardas un asiento junto a la ventana? | reg:casual gen:unknown amb:— | 3667 ms | 419 (300) | $0.00221 |
| gpt-5.4-mini:low | Por eso somos amigos. ¿Me guardas un asiento junto a la ventana? | reg:casual gen:unknown amb:— | 2208 ms | 210 (50) | $0.00158 |
| gpt-4o-mini (old) | Por eso somos amigos. ¿Me guardas un lugar junto a la ventana? | reg:casual amb:— | 3090 ms | 145 (0) | $0.00028 |

## Case 7: convo #7 (diego → en)
**Original:** `Ya te la aparté, pero si tardas más de 10 min me como tus tacos eh`  
**Watch for:** v2.0.0 lowercased + "i'm"; "eh" pragmatics

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | I already saved it for you, but if you're more than 10 min late I'm eating your tacos just saying | reg:casual gen:unknown amb:— | 6241 ms | 694 (512) | $0.01360 |
| gpt-5.4:low | Already saved it for you, but if you take more than 10 min I'm eating your tacos lol | reg:casual gen:unknown amb:— | 1686 ms | 186 (9) | $0.00598 |
| gpt-5.4:none | I already saved it for you, but if you're more than 10 min late I'm eating your tacos lol | reg:casual gen:unknown amb:— | 1564 ms | 172 (0) | $0.00577 |
| gpt-5.4-mini:medium | I've already saved you your seat, but if you're more than 10 min late I'm eating your tacos, eh | reg:casual gen:unknown amb:✓(2 alts) | 5662 ms | 830 (512) | $0.00345 |
| gpt-5.4-mini:low | I already saved it for you, but if you're more than 10 min late I'm eating your tacos, eh | reg:casual gen:unknown amb:— | 3143 ms | 331 (207) | $0.00195 |
| gpt-4o-mini (old) | I saved you a spot, but if you take longer than 10 minutes, I'm eating your tacos, okay? | reg:casual amb:— | 2704 ms | 155 (0) | $0.00028 |

## Case 8: convo #8 (peter → es)
**Original:** `Fair enough lol`  
**Watch for:** general nuance + casing fidelity

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | Está bien jajaja | reg:casual gen:unknown amb:— | 5682 ms | 537 (384) | $0.01121 |
| gpt-5.4:low | Bueno, va jajaja | reg:casual gen:unknown amb:— | 4724 ms | 368 (206) | $0.00868 |
| gpt-5.4:none | Va, jajaja | reg:casual gen:unknown amb:— | 1147 ms | 103 (0) | $0.00470 |
| gpt-5.4-mini:medium | Va jajaja | reg:casual gen:unknown amb:— | 4089 ms | 462 (305) | $0.00233 |
| gpt-5.4-mini:low | Está bien jajaja | reg:casual gen:unknown amb:— | 2098 ms | 217 (64) | $0.00160 |
| gpt-4o-mini (old) | Está bien, jajaja | reg:casual amb:— | 1571 ms | 135 (0) | $0.00027 |

## Case 9: casing A: proper caps + heavy slang (en → es)
**Original:** `Bro I can't even lie, that concert was INSANE. I'm still deaf lol`  
**Watch for:** sender capitalizes properly — output must too, despite slang density

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | Bro no te voy a mentir, ese concierto estuvo BRUTAL. Todavía no escucho nada jajaja | reg:casual gen:unknown amb:— | 5248 ms | 627 (431) | $0.01236 |
| gpt-5.4:low | Bro, la neta, no te voy a mentir, ese concierto estuvo INSANO. Todavía sigo sordo jajaja | reg:casual gen:unknown amb:— | 2616 ms | 207 (13) | $0.00606 |
| gpt-5.4:none | Bro, no te voy a mentir, ese concierto estuvo INSANO. Todavía sigo sordo jajaja | reg:casual gen:unknown amb:— | 5877 ms | 127 (0) | $0.00486 |
| gpt-5.4-mini:medium | Bro no te voy a mentir, ese concierto estuvo UNA LOCURA. Todavía no oigo bien jajaja | reg:casual gen:unknown amb:— | 5142 ms | 644 (512) | $0.00282 |
| gpt-5.4-mini:low | Bro no te voy a mentir, ese concierto estuvo LOQUÍSIMO. sigo sin oír nada lol | reg:casual gen:unknown amb:— | 3669 ms | 376 (240) | $0.00202 |
| gpt-4o-mini (old) | Bro, no puedo mentir, ese concierto fue UNA LOCURA. Aún estoy sordo jajaja | reg:casual gen:unknown amb:— | 2657 ms | 156 (0) | $0.00027 |

## Case 10: casing B: all-lowercase sender stays lowercase (en → es)
**Original:** `yo whats up, we still on for tonight or nah`  
**Watch for:** sender writes all-lowercase — output must NOT be corrected to proper caps

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | oye qué onda, sigue en pie lo de esta noche o no | reg:casual gen:unknown amb:— | 6788 ms | 610 (485) | $0.01209 |
| gpt-5.4:low | oye qué onda, seguimos en pie para esta noche o nel | reg:casual gen:unknown amb:— | 2131 ms | 193 (20) | $0.00584 |
| gpt-5.4:none | yo qué onda, ¿seguimos en pie para esta noche o nel? | reg:casual gen:unknown amb:— | 1533 ms | 123 (0) | $0.00479 |
| gpt-5.4-mini:medium | ey qué onda seguimos en pie para esta noche o no | reg:casual gen:unknown amb:— | 4300 ms | 582 (404) | $0.00263 |
| gpt-5.4-mini:low | oye qué onda, seguimos para esta noche o no | reg:casual gen:unknown amb:— | 1985 ms | 200 (80) | $0.00148 |
| gpt-4o-mini (old) | ¿Qué onda? ¿Todavía vamos a salir esta noche o qué? | reg:casual amb:— | 1575 ms | 144 (0) | $0.00026 |

## Case 11: gender A: feminine speaker, adjective agreement (en → es)
**Original:** `I'm exhausted after today, I'm just glad it's over`  
**Watch for:** profile says feminine → "cansada/agotada", never "cansado/agotado"

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | Estoy agotada después de hoy, solo me alegra que ya se acabó | reg:casual amb:— | 5886 ms | 582 (467) | $0.01169 |
| gpt-5.4:low | Estoy agotada después de hoy, la neta qué bueno que ya se acabó | reg:casual gen:feminine amb:— | 4597 ms | 253 (57) | $0.00675 |
| gpt-5.4:none | Estoy agotada después de hoy, nomás me da gusto que ya terminó | reg:casual gen:feminine amb:— | 6295 ms | 116 (0) | $0.00470 |
| gpt-5.4-mini:medium | Estoy agotada después de hoy, solo me alegra que ya haya terminado | reg:casual gen:feminine amb:— | 4719 ms | 573 (413) | $0.00261 |
| gpt-5.4-mini:low | Estoy agotada después de hoy, solo me alegra que ya se acabó | reg:casual gen:feminine amb:— | 5235 ms | 254 (135) | $0.00165 |
| gpt-4o-mini (old) | Estoy agotada después de hoy, solo me alegra que ya haya terminado. | reg:casual gen:feminine amb:— | 3241 ms | 148 (0) | $0.00027 |

## Case 12: gender B: unknown gender, agreement forced (en → es)
**Original:** `I'm so excited for tomorrow`  
**Watch for:** no gender in profile — does it default masculine ("emocionado") or find neutral phrasing ("me emociona mucho")? masculine default = product bug

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | Tengo muchísimas ganas de mañana | reg:casual gen:neutral amb:— | 5148 ms | 466 (361) | $0.00992 |
| gpt-5.4:low | Tengo muchísimas ganas de mañana | reg:casual gen:unknown amb:— | 2097 ms | 209 (49) | $0.00607 |
| gpt-5.4:none | Me emociona muchísimo mañana | reg:casual gen:unknown amb:— | 1121 ms | 99 (0) | $0.00441 |
| gpt-5.4-mini:medium | Qué emoción para mañana | reg:casual gen:unknown amb:— | 3077 ms | 304 (157) | $0.00179 |
| gpt-5.4-mini:low | Qué emoción por mañana | reg:casual gen:unknown amb:— | 2624 ms | 233 (128) | $0.00158 |
| gpt-4o-mini (old) | Estoy tan emocionado por mañana | reg:casual gen:masculine amb:— | 2096 ms | 139 (0) | $0.00026 |

## Case 13: register A: formal message from casual-profile user (en → es)
**Original:** `Good evening, I wanted to confirm our meeting tomorrow at 3 PM. Please let me know if that still works.`  
**Watch for:** formal message must STAY formal (usted register) even though profile says casual

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | Buenas noches, quería confirmar nuestra reunión de mañana a las 3 PM. Avísame si eso todavía te funciona. | reg:professional gen:unknown amb:— | 5242 ms | 539 (371) | $0.01106 |
| gpt-5.4:low | Buenas noches, quería confirmar nuestra reunión de mañana a las 3 PM. Avísame por favor si te sigue funcionando. | reg:formal gen:unknown amb:— | 1611 ms | 144 (21) | $0.00514 |
| gpt-5.4:none | Buenas noches, quería confirmar nuestra reunión de mañana a las 3 PM. Avísame si todavía te queda bien. | reg:casual gen:unknown amb:— | 1643 ms | 117 (0) | $0.00473 |
| gpt-5.4-mini:medium | Buenas noches, quería confirmar nuestra reunión de mañana a las 3 PM. Avísame si todavía te viene bien. | reg:formal gen:unknown amb:— | 5658 ms | 686 (511) | $0.00295 |
| gpt-5.4-mini:low | Buenas tardes, quería confirmar nuestra reunión de mañana a las 3 PM. Por favor, avísame si todavía te funciona. | reg:casual gen:unknown amb:— | 1608 ms | 199 (31) | $0.00149 |
| gpt-4o-mini (old) | Buenas tardes, quería confirmar nuestra reunión mañana a las 3 PM. Avísame si sigue en pie. | reg:casual gen:unknown amb:— | 2588 ms | 152 (0) | $0.00027 |

## Case 14: register B: professional context type, T-V choice (en → es)
**Original:** `Can you send over the report when you get a chance? No rush.`  
**Watch for:** contextType=professional (first non-casual test of the modifier path) → usted forms, workplace tone kept

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | ¿Podría enviarme el informe cuando tenga un momento? No hay prisa. | reg:professional gen:unknown amb:— | 40986 ms | 1047 (861) | $0.01866 |
| gpt-5.4:low | ¿Puede enviarme el informe cuando tenga un momento? No hay prisa. | reg:professional gen:unknown amb:— | 17254 ms | 238 (66) | $0.00653 |
| gpt-5.4:none | ¿Puede enviarme el informe cuando tenga un momento? No hay prisa. | reg:professional gen:unknown amb:— | 2148 ms | 116 (0) | $0.00470 |
| gpt-5.4-mini:medium | ¿Puedes enviarme el informe cuando tengas un momento? Sin prisa. | reg:professional gen:unknown amb:— | 3569 ms | 380 (259) | $0.00203 |
| gpt-5.4-mini:low | ¿Puedes enviarme el informe cuando tengas un momento? No hay prisa. | reg:professional gen:unknown amb:— | 2097 ms | 225 (68) | $0.00156 |
| gpt-4o-mini (old) | ¿Puedes enviarme el informe cuando tengas un momento? Sin prisa. | reg:casual amb:— | 3230 ms | 144 (0) | $0.00026 |

## Case 15: context A: reaction needing history (es → en)
**Original:** `Jajaja no lo puedo creer, hasta que por fin`  
**Watch for:** "hasta que por fin" = "finally!/about time" reacting to Peter's news — needs history

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | Haha I can't believe it, about time | reg:casual gen:unknown amb:✓(2 alts) | 6250 ms | 578 (314) | $0.01170 |
| gpt-5.4:low | Haha I can't believe it, it's about time | reg:casual gen:unknown amb:— | 3629 ms | 260 (93) | $0.00693 |
| gpt-5.4:none | Haha I can't believe it, it's about time | reg:casual gen:unknown amb:— | 1569 ms | 112 (0) | $0.00471 |
| gpt-5.4-mini:medium | Haha, I can't believe it, about time | reg:casual gen:unknown amb:— | 6818 ms | 679 (512) | $0.00295 |
| gpt-5.4-mini:low | Haha I can't believe it, finally | reg:casual gen:unknown amb:— | 1577 ms | 153 (37) | $0.00137 |
| gpt-4o-mini (old) | Haha I can't believe it, finally! | reg:casual amb:— | 2176 ms | 144 (0) | $0.00027 |

## Case 16: context B: pronoun referent from history (en → es)
**Original:** `She's going to love it, trust me`  
**Watch for:** "she" = the mom from history → "le va a encantar" with correct referent, no invented subject

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | Le va a encantar, créeme | reg:casual gen:unknown amb:— | 4632 ms | 414 (305) | $0.00924 |
| gpt-5.4:low | Le va a encantar, créeme | reg:casual gen:unknown amb:— | 2110 ms | 184 (24) | $0.00579 |
| gpt-5.4:none | Le va a encantar, créeme | reg:casual gen:unknown amb:— | 4237 ms | 104 (0) | $0.00459 |
| gpt-5.4-mini:medium | Le va a encantar, créeme | reg:casual gen:unknown amb:— | 3654 ms | 296 (187) | $0.00180 |
| gpt-5.4-mini:low | Le va a encantar, confía en mí | reg:casual gen:unknown amb:— | 1544 ms | 204 (51) | $0.00152 |
| gpt-4o-mini (old) | Le va a encantar, confía en mí | reg:casual amb:— | 1562 ms | 140 (0) | $0.00027 |

## Case 17: idiom: "crudo" = hungover, not raw (es → en)
**Original:** `No mames, estoy bien crudo, anoche fue demasiado`  
**Watch for:** "crudo" (MX) = hungover — "raw" is the literal-translation failure; "no mames" energy kept

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | Fuck, I'm so hungover, last night was too much | reg:casual gen:masculine amb:— | 39325 ms | 476 (302) | $0.01009 |
| gpt-5.4:low | No way, I'm so hungover, last night was too much | reg:casual gen:unknown amb:— | 1568 ms | 185 (10) | $0.00573 |
| gpt-5.4:none | No way, I'm so hungover, last night was too much | reg:casual gen:unknown amb:— | 3147 ms | 161 (0) | $0.00537 |
| gpt-5.4-mini:medium | Damn, I'm really hungover, last night was too much | reg:casual gen:unknown amb:— | 4354 ms | 638 (464) | $0.00280 |
| gpt-5.4-mini:low | No way, I'm so hungover, last night was too much | reg:casual gen:unknown amb:— | 1940 ms | 208 (87) | $0.00151 |
| gpt-4o-mini (old) | No way, I'm so hungover, last night was too much | reg:casual gen:unknown amb:— | 2104 ms | 158 (0) | $0.00027 |

## Case 18: ambiguity: "that's sick" — cool vs ill (en → es)
**Original:** `That's sick man`  
**Watch for:** genuinely ambiguous with no history — ambiguity.detected should fire with both readings in alternatives

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | Qué chido bro | reg:casual gen:unknown amb:— | 8909 ms | 956 (790) | $0.01726 |
| gpt-5.4:low | Está brutal, wey | reg:casual gen:unknown amb:— | 2127 ms | 199 (37) | $0.00591 |
| gpt-5.4:none | Está buenísimo, man | reg:casual gen:unknown amb:— | 2062 ms | 103 (0) | $0.00447 |
| gpt-5.4-mini:medium | Está brutal, man | reg:casual gen:unknown amb:✓(2 alts) | 5246 ms | 668 (497) | $0.00288 |
| gpt-5.4-mini:low | Eso está brutal, bro | reg:casual gen:unknown amb:— | 2091 ms | 197 (91) | $0.00147 |
| gpt-4o-mini (old) | Eso está increíble, amigo. | reg:casual gen:masculine amb:— | 1642 ms | 138 (0) | $0.00026 |

## Case 22: referent (novel) A: elliptical "her" from history (en → es)
**Original:** `Tell her I said hi! Can't wait to finally meet her`  
**Watch for:** "her" = Diego's sister from history → "dile que..." with correct referent, no invented subject

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | ¡Dile que le mando saludos! Ya quiero conocerla por fin | reg:casual gen:neutral amb:— | 16778 ms | 600 (422) | $0.01203 |
| gpt-5.4:low | ¡Dile que le mando saludos! Ya quiero conocerla por fin | reg:casual gen:unknown amb:— | 2578 ms | 231 (57) | $0.00650 |
| gpt-5.4:none | ¡Dile que le mandé saludos! Ya quiero por fin conocerla | reg:casual gen:unknown amb:— | 1546 ms | 118 (0) | $0.00480 |
| gpt-5.4-mini:medium | ¡Dile que le mando saludos! No puedo esperar a conocerla por fin | reg:casual gen:unknown amb:— | 4323 ms | 571 (396) | $0.00262 |
| gpt-5.4-mini:low | ¡Dile que le mando saludos! Ya quiero conocerla por fin | reg:casual gen:unknown amb:— | 6165 ms | 470 (305) | $0.00232 |
| gpt-4o-mini (old) | ¡Dile que le mando saludos! No puedo esperar para conocerla al fin | reg:casual amb:— | 1616 ms | 147 (0) | $0.00027 |

## Case 23: referent (novel) B: reaction about the OTHER speaker (es → en)
**Original:** `Ya era hora!! Si llevas años hablando de eso`  
**Watch for:** "About time!! YOU've been talking about it for years" — about Peter, not rewritten as if about the sender ("I've been...")

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | About time!! You've been talking about that for years | reg:casual gen:unknown amb:— | 3105 ms | 346 (189) | $0.00822 |
| gpt-5.4:low | About time!! You've been talking about that for years | reg:casual gen:unknown amb:— | 2735 ms | 219 (55) | $0.00632 |
| gpt-5.4:none | About time!! You've been talking about that for years | reg:casual gen:unknown amb:— | 1981 ms | 106 (0) | $0.00462 |
| gpt-5.4-mini:medium | About time!! You've been talking about that for years | reg:casual gen:unknown amb:— | 4799 ms | 632 (512) | $0.00281 |
| gpt-5.4-mini:low | It was about time!! You've been talking about that for years | reg:casual gen:unknown amb:— | 1488 ms | 152 (28) | $0.00137 |
| gpt-4o-mini (old) | It's about time!! You've been talking about that for years | reg:casual amb:— | 2097 ms | 144 (0) | $0.00027 |

## Case 19: CJK A: casual Japanese + laughter conversion (en → ja)
**Original:** `lmaooo no way you actually did that`  
**Watch for:** casual register (no です/ます), laughter → 笑/w/ｗ, not a stiff textbook sentence

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | www うそでしょほんとにそれやったの | reg:casual gen:unknown amb:— | 3151 ms | 304 (137) | $0.00750 |
| gpt-5.4:low | www うそでしょほんとにそれやったの | reg:casual gen:unknown amb:— | 2089 ms | 190 (70) | $0.00579 |
| gpt-5.4:none | www まさかほんとにそんなことしたの | reg:casual gen:unknown amb:— | 1670 ms | 112 (0) | $0.00462 |
| gpt-5.4-mini:medium | うそでしょwww ほんとにやったの？ | reg:casual gen:unknown amb:— | 3649 ms | 425 (305) | $0.00216 |
| gpt-5.4-mini:low | 草ｗｗ まじでそれやったの？ | reg:casual gen:unknown amb:— | 2019 ms | 175 (57) | $0.00141 |
| gpt-4o-mini (old) | マジでそれやったの？笑 | reg:casual amb:— | 3141 ms | 143 (0) | $0.00026 |

## Case 20: CJK B: formal Japanese keigo (en → ja)
**Original:** `Good evening, I wanted to confirm our meeting tomorrow at 3 PM. Please let me know if that still works.`  
**Watch for:** proper keigo (です/ます minimum, ideally 確認させていただきたい register) — the hardest formality test in the set

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | こんばんは。明日の午後3時の打ち合わせについて、確認のためご連絡しました。引き続きそのお時間で問題ないか、ご確認いただけますと幸いです。 | reg:professional gen:unknown amb:— | 5772 ms | 446 (261) | $0.00967 |
| gpt-5.4:low | こんばんは。明日午後3時の打ち合わせについて、確認させていただければと思います。ご都合に変更がなければ、その旨お知らせください。 | reg:professional gen:unknown amb:— | 2111 ms | 132 (0) | $0.00496 |
| gpt-5.4:none | こんばんは。明日午後3時の打ち合わせについて、確認させていただきたくご連絡しました。ご都合に変更がなければ、その旨お知らせください。 | reg:professional gen:unknown amb:— | 2604 ms | 179 (0) | $0.00566 |
| gpt-5.4-mini:medium | こんばんは。明日午後3時の打ち合わせについて確認したく、ご連絡しました。まだそのお時間で問題ないか、ご一報いただけますと幸いです。 | reg:professional gen:unknown amb:— | 2097 ms | 192 (54) | $0.00147 |
| gpt-5.4-mini:low | こんばんは。明日の午後3時の会議について確認したく、ご連絡しました。まだその時間で問題ないか、ご連絡いただけますと幸いです。 | reg:professional gen:unknown amb:— | 2097 ms | 144 (7) | $0.00133 |
| gpt-4o-mini (old) | こんばんは、明日の午後3時の会議を確認したいと思います。それがまだ大丈夫か教えてください。 | reg:professional amb:— | 3161 ms | 154 (0) | $0.00027 |

## Case 21: CJK C: casual Chinese + cultural item (en → zh)
**Original:** `hahaha ok I'm coming over, save me some tamales`  
**Watch for:** laughter → 哈哈哈, "tamales" kept (transliterated or named, not literally glossed), casual tone

| candidate | translation | flags | latency | out tok (reasoning) | cost |
|---|---|---|---|---|---|
| gpt-5.4:medium | 哈哈哈好 我过去啦，给我留点 tamales | reg:casual gen:unknown amb:— | 4705 ms | 487 (321) | $0.01025 |
| gpt-5.4:low | 哈哈哈好 我过去啦，给我留点 tamales | reg:casual gen:unknown amb:— | 2618 ms | 244 (66) | $0.00661 |
| gpt-5.4:none | 哈哈哈好，我过去了，给我留点 tamales | reg:casual gen:unknown amb:— | 57146 ms | 122 (0) | $0.00478 |
| gpt-5.4-mini:medium | 哈哈哈 ok 我这就过去，给我留点 tamales | reg:casual gen:unknown amb:— | 4726 ms | 615 (445) | $0.00273 |
| gpt-5.4-mini:low | 哈哈哈 ok 我这就过去，给我留点 tamales | reg:casual gen:unknown amb:— | 2618 ms | 293 (121) | $0.00176 |
| gpt-4o-mini (old) | 哈哈哈，好，我马上过来，留点玉米饼给我吧 | reg:casual amb:— | 3152 ms | 147 (0) | $0.00027 |

## Summary (averages over successful calls)
| candidate | avg latency | avg cost/call | est. cost/1k msgs | errors |
|---|---|---|---|---|
| gpt-5.4:medium | 11783 ms | $0.01182 | ~$11.82 | 0 |
| gpt-5.4:low | 5296 ms | $0.00647 | ~$6.47 | 0 |
| gpt-5.4:none | 4958 ms | $0.00492 | ~$4.92 | 0 |
| gpt-5.4-mini:medium | 4576 ms | $0.00252 | ~$2.52 | 0 |
| gpt-5.4-mini:low | 2511 ms | $0.00163 | ~$1.63 | 0 |
| gpt-4o-mini (old) | 2546 ms | $0.00027 | ~$0.27 | 0 |