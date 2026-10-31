# Angoli — plugin per Fontra

Pannello per arrotondare e smussare gli angoli dei contorni in Fontra, con anteprima live sul canvas. Come i "live corners" di Illustrator, gli angoli arrotondati **restano angoli**: puoi cambiarne il raggio quando vuoi, anche diversamente da un master all'altro.

## Cosa fa

- **Arrotonda** gli angoli con un arco vero (raggio in unità del font), oppure **Smussa** con un taglio dritto.
- **Tensione della curva**: 1 = arco di cerchio. Più alto = raccordo più "squadrato" (superellisse), più basso = più morbido.
- **Punti selezionati** oppure **Tutto il glifo**.
- Filtro **Esterni / Interni / Tutti**. Esterni sono gli spigoli che sporgono dalla forma piena, interni quelli rientranti (attacchi delle aste, controforme).
- Funziona anche con angoli tra una retta e una curva: la curva viene tagliata e il raccordo resta tangente.
- Se il raggio è troppo grande per il segmento, viene ridotto automaticamente. Con un raggio pari a metà asta ottieni un terminale semicircolare.
- **Seleziona angoli**: seleziona tutti gli angoli del glifo (vivi e arrotondati) che corrispondono al filtro, così puoi togliere quelli che non vuoi prima di applicare.
- Ogni modifica si annulla con ⌘Z / Ctrl+Z.

## Angoli arrotondati modificabili

- Un angolo arrotondato viene riconosciuto come angolo, non come curva qualsiasi. Il plugin trova lo spigolo "virtuale" in cui si incontrano i due lati e ne ricava **raggio** e **tensione**. Vale per gli angoli fatti con il plugin, ma anche per quelli disegnati in Glyphs o a mano, purché almeno un lato sia dritto.
- Seleziona l'angolo arrotondato (basta uno dei suoi punti) e premi **Applica**: cambia solo il raggio. Il pannello mostra il raggio attuale nel master su cui ti trovi.
- Cambiare il raggio **non aggiunge né toglie punti**: sposta solo quelli del raccordo, e le maniglie del lato vicino se è una curva. I master restano compatibili.
- **Pallini sul canvas**: con il pannello aperto, dentro ogni angolo coinvolto compare un pallino. Trascinalo verso l'interno per aumentare il raggio, verso lo spigolo per ridurlo. **Maiusc** = passi da 5, **Esc** = annulla il trascinamento. Mentre trascini vedi il risultato in anteprima; la modifica viene applicata quando rilasci.
- **Mantieni la tensione** (attivo di serie): cambiando il raggio di un angolo già arrotondato, la sua tensione resta quella che aveva. Se lo spegni, viene usata quella del pannello.

## Master e interpolazione

- **Stesso raggio in tutti i master** attivo: il raggio viene applicato a tutti i master.
- **Stesso raggio in tutti i master** spento: il raggio vale **solo per il master su cui ti trovi**.
  - Se arrotondi un angolo vivo, i nuovi punti vengono comunque aggiunti in tutti i master, perché l'interpolazione ha bisogno della stessa struttura ovunque. Negli altri master però il raccordo ha **raggio 0**: i quattro punti stanno sovrapposti nello spigolo, che resta vivo.
  - Quando passi a un altro master, selezioni l'angolo e gli dai il suo raggio.
  - Le istanze intermedie interpolano il raggio. Per esempio, tra un master con raggio 20 e uno con raggio 90, a metà ottieni un raggio di circa 55.
- Se non sei esattamente su un master, il plugin te lo dice e non modifica niente, a meno che tu non attivi "Stesso raggio in tutti i master".

## Installazione

Il Plugin Manager di Fontra carica i plugin da un repository GitHub pubblico, tramite il CDN jsDelivr.

1. Crea un repository **pubblico** su GitHub, per esempio `fontra-angoli`.
2. Carica i file `plugin.json`, `corners.js` e `icon.svg` (va bene anche questo README) con **Add file → Upload files**, nella radice del repository.
3. Crea una release: **Releases → Create a new release**, tag `v1.0.0`, **Publish release**.
4. In Fontra apri il menu **Fontra → Plugin Manager**, premi **+** e scrivi `tuonomeutente/fontra-angoli`. Conferma.
5. Ricarica la finestra dell'editor. Nella barra laterale destra compare l'icona dell'angolo arrotondato.

Il campo del Plugin Manager accetta anche un URL completo, per esempio `https://cdn.jsdelivr.net/gh/tuonomeutente/fontra-angoli@v1.0.0`, utile per fissare una versione precisa.

### Aggiornare il plugin

Modifica i file su GitHub e crea una nuova release (`v1.0.1`, …). jsDelivr tiene in cache `@latest` per un po': se la nuova versione non arriva, aspetta qualche ora oppure usa l'URL con la versione esplicita.

## Limiti

- Lavora sui contorni, non sui componenti. Per arrotondare un componente devi prima scomporlo.
- Le curve quadratiche (TrueType) non sono supportate. Gli angoli adiacenti a curve quadratiche vengono ignorati.
- Se due contorni si sovrappongono, vengono arrotondati anche gli angoli nascosti nella sovrapposizione. Unisci i contorni prima di applicare.
- Una curva tra due lati entrambi curvi non viene considerata un angolo arrotondato: sarebbe impossibile distinguerla da una curva normale.
- Due angoli arrotondati attaccati, senza un tratto in mezzo, non si possono regolare. Una testa semicircolare invece sì, perché il tratto in mezzo esiste, anche se è lungo zero.
- Se un raggio è più grande dello spazio disponibile, viene ridotto. Il raggio letto in seguito è quello reale, non quello richiesto.
- I master con una struttura diversa da quello corrente vengono saltati, e il pannello te lo segnala.
