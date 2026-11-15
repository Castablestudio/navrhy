# Stav webů (pojistka na nezaplacení)

Každý spuštěný web klienta si při načtení přečte svůj soubor `<domena-s-pomlckami>.json`.

- `{"stav":"aktivni"}` → web běží normálně (výchozí).
- `{"stav":"vypnuto"}` → web se překryje neutrální hláškou „Web se právě aktualizuje“ s kontaktem na firmu. Ordinace/firma funguje dál, jen nový web není vidět.

Vypnutí i zapnutí = změna tohoto souboru a push. Projeví se do minuty. Když se soubor nenačte (náš výpadek), web běží dál (fail-open), klientovi se web kvůli nám nikdy nevypne omylem.

Používá se, dokud klient nezaplatí. Po zaplacení soubor zůstává na „aktivni“.
