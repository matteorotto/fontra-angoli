# Angoli — plugin per Fontra

Pannello per arrotondare e smussare gli angoli dei contorni in Fontra, con anteprima live sul canvas.

## Cosa fa

- **Arrotonda** gli angoli con un arco vero (raggio in unità del font), oppure **Smussa** con un taglio dritto.
- **Tensione della curva**: 1 = arco di cerchio. Più alto = raccordo più "squadrato" (superellisse), più basso = più morbido.
- **Punti selezionati** oppure **Tutto il glifo**.
- Filtro **Esterni / Interni / Tutti**. Esterni sono gli spigoli che sporgono dalla forma piena, interni quelli rientranti (attacchi delle aste, controforme).
- **Tutti i master**: applica la stessa modifica a tutte le sorgenti del glifo, così i font variabili restano compatibili.
- Funziona anche con angoli tra una retta e una curva: la curva viene tagliata e il raccordo resta tangente.
- Se il raggio è troppo grande per il segmento, viene ridotto automaticamente. Con un raggio pari a metà asta ottieni un terminale semicircolare.
- **Seleziona angoli**: seleziona tutti gli angoli del glifo che corrispondono al filtro, così puoi togliere quelli che non vuoi prima di applicare.
- Ogni modifica si annulla con ⌘Z / Ctrl+Z.

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
- Con **Tutti i master** attivo, i master con una struttura diversa da quello corrente vengono saltati, e il pannello te lo segnala.
