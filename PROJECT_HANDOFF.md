# PROJECT HANDOFF — Ribolov natjecanja

> **Namjena dokumenta:** prijenos konteksta u ChatGPT Work ili drugom developeru/agentu. Ovo nije samo tehnička dokumentacija; bilježi i razloge iza odluka, smjer projekta i stvari koje se ne smiju pretpostaviti.
>
> **Stanje handoffa:** 21. 9. 2026.

## 1. Što je projekt

Web aplikacija za vođenje i izračun rezultata ekipnih ribolovnih natjecanja. Nastala je prvenstveno kao praktičan alat za Lukin vlastiti krug natjecanja, a ne kao SaaS/proizvod za tržište.

Glavni cilj je da na natjecanju bude maksimalno jednostavna i pouzdana:
- organizator kreira natjecanje;
- dobije 6-znamenkasti kod;
- vagari se priključe kodom bez registracije;
- unose težine/status po sektorima;
- podaci se sinkroniziraju online;
- aplikacija automatski računa sektorske i ekipne rezultate;
- rezultati se mogu prikazati/izvesti.

**Važna produktna odluka:** u ovom trenutku ne graditi generičku platformu za sve lige, vode i klubove. Prioritet su funkcije koje trebaju nama. Statistika ostaje u planu, ali prvenstveno statistika konkretnog natjecanja. Dugoročne analize voda/liga zasad nisu prioritet.

## 2. Vlasnik i način rada

Vlasnik/projektni donositelj odluka: **Luka Jurak**.

Luka nije developer i ne treba ga opterećivati implementacijskim detaljima kada nisu potrebni. Kada se traže odluke, objasniti posljedice jednostavnim jezikom. Kod većih zahvata prvo razumjeti stvarni workflow na ribolovnom natjecanju, pa tek onda mijenjati kod.

Preferirani princip:
1. prvo definirati što funkcija treba raditi u stvarnom natjecanju;
2. provjeriti postojeću arhitekturu;
3. napraviti najmanju sigurnu promjenu;
4. testirati scoring/sync i postojeći workflow;
5. tek onda deploy.

Ne dodavati kompleksnost samo zato što je tehnički moguća.

## 3. Repo, produkcija i backup

GitHub repo:
- **Jurakluka18/ribolov-natjecanja**
- aktivni razvoj: **main**
- sigurnosni snapshot/kostur: **osnovni-kostur-2026-09-21**

Branch `osnovni-kostur-2026-09-21` je namjerno napravljen prije daljnjih prilagodbi za naše potrebe. **Ne razvijati na njemu i ne mijenjati ga bez izričitog Lukinog zahtjeva.** Njegova svrha je sačuvati relativno čist kostur ako se jednog dana odluči graditi šira/proizvodna verzija.

Produkcija:
- Vercel projekt: `ribolov-natjecanja`
- javna domena: https://ribolov-natjecanja.vercel.app/
- `main` je spojen na production deployment.

Admin:
- https://ribolov-natjecanja.vercel.app/admin

## 4. Tehnologije

Frontend:
- React 19
- TypeScript
- Vite 8

Backend/data:
- Supabase/Postgres
- Supabase Realtime
- Supabase Auth koristi se za admin pristup

Export:
- jsPDF
- jspdf-autotable
- html2canvas

Test framework je prisutan:
- Vitest

Prije većih promjena koristiti postojeće testove i, kada se dira scoring, dodati/pojačati testove umjesto oslanjanja samo na ručno klikanje.

## 5. Ključne datoteke

- `src/App.tsx` — glavni UI i workflow aplikacije.
- `src/scoring.ts` — scoring logika; tretirati kao kritični poslovni kod.
- `src/supabase.ts` — Supabase tipovi i CRUD operacije.
- `src/sync.ts` — mapiranje DB/lokalnog stanja, localStorage i offline queue.
- `src/useOnlineSync.ts` — online/realtime sinkronizacija.
- `src/Admin.tsx` — admin UI.
- `src/styles.css` — stilovi.
- `vercel.json` — SPA routing, potreban i za direktan `/admin`.
- `.env.example` — samo placeholderi; nikada commitati stvarne ključeve.

## 6. Trenutni model natjecanja

Trenutni core je namjerno jednostavan:
- sektori su **A, B, C**;
- postoji N ekipa;
- svaka ekipa ima poziciju/rezultat u svakom sektoru;
- težina se sprema u gramima;
- status pozicije podržava `normal`, `absent`, `yellow`, `red`;
- lokalno stanje i online stanje mapiraju se jedno na drugo.

U `App.tsx` postoje stranice/workflow tipa:
- setup
- weigh
- sectors
- teams

Ne generalizirati broj sektora, discipline ili format natjecanja bez konkretnog zahtjeva. To može jednog dana biti potrebno za proizvod, ali sada bi nepotrebno zakompliciralo naš alat.

## 7. Supabase projekt

Project ref:
- **bryhhpsgwkzamjvoyvia**
- naziv: **Program za izračun rezultata**
- regija: eu-west-1

Glavne tablice:

### public.competitions
Bitna polja:
- `id uuid`
- `code text unique`
- `name text`
- `num_teams int`
- `team_names jsonb`
- `created_at timestamptz`
- `updated_at timestamptz`

### public.positions
Bitna polja:
- `competition_id uuid`
- `sector text`
- `team_number int`
- `weight_grams int nullable`
- `status text`
- `updated_at timestamptz`
- `updated_by text nullable`

Composite PK:
- `(competition_id, sector, team_number)`

FK:
- `positions.competition_id -> competitions.id ON DELETE CASCADE`

To znači da brisanje natjecanja automatski briše pripadajuće pozicije.

## 8. Retention — 7 dana

Natjecanja su trenutno privremena.

Postoji Supabase pg_cron job koji jednom dnevno briše:
```sql
delete from public.competitions
where created_at < now() - interval '7 days';
```

Raspored je dnevno oko **03:15**.

**Ključna semantika:** 7 dana računa se od `created_at`, NE od zadnje aktivnosti i NE od `updated_at`. Izmjene natjecanja ne produžuju život natjecanja.

Zbog dnevnog crona stvarno brisanje može biti do približno 24 h nakon prelaska točno 7 dana.

Ako se kasnije uvede povijesna statistika, ne mijenjati ovaj retention napamet. Prvo odlučiti treba li odvojiti privremene operativne podatke od trajnog arhivskog/statističkog zapisa.

## 9. Online sync i offline ponašanje

Aktivno online natjecanje sprema se u localStorage. Postoji offline queue za izmjene pozicija.

Važan dizajn:
- promjene se mogu privremeno queueati;
- po istoj poziciji zadnja izmjena pobjeđuje;
- cijelo zadnje stanje online natjecanja sprema se lokalno, pa se natjecanje može ponovno otvoriti i bez signala;
- svaki unos prvo se trajno sprema u lokalni queue, a tek nakon potvrde baze uklanja iz njega;
- potvrda starijeg upisa ne smije ukloniti noviju izmjenu iste pozicije;
- slanje se automatski ponavlja svakih 5 sekundi, pri povratku mreže, fokusu prozora i povratku aplikacije u prvi plan;
- svakih 15 sekundi dohvaća se svježi snapshot iz baze, ali lokalni nepotvrđeni unosi imaju prednost dok ne budu poslani;
- Supabase Realtime prenosi promjene drugim klijentima.

U zaglavlju je namjerno ostao samo diskretan indikator: zelena/žuta/crvena točka i mali broj nepotvrđenih rezultata. Vagar ne treba ručno osvježavati niti pokretati sinkronizaciju.

Ovo je važno jer aplikacija radi na terenu gdje mobilna veza može biti loša. **Ne uklanjati offline/retry ponašanje radi pojednostavljenja bez izričitog razloga.**

## 10. Admin

Admin ekran je na `/admin`.

Admin email:
- `mailzaigre15@gmail.com`

Admin koristi Supabase Auth i server-side provjerene admin RPC funkcije. Admin može pregledati aktivna natjecanja, vidjeti retention/istek i ručno brisati.

Lozinka nije dio repozitorija niti ovog dokumenta.

### Sigurnosna napomena

Trenutni RLS model za core tablice je povijesno ostao vrlo permisivan kako bi anonimni vagari/organizatori mogli raditi bez računa. Postoje/ postojale su public permissive politike za SELECT/INSERT/UPDATE/DELETE na competitions i positions.

Zato **admin UI nije isto što i potpuna end-to-end zaštita baze**.

Nemoj tvrditi da samo admin može brisati/mijenjati podatke dok se RLS ponovno ne auditira i redesignira cijeli anonymous workflow.

Razlog zašto public DELETE nije samo uklonjen: normalni app workflow koristi `deleteCompetition(active.id)` za reset/brisanje aktivnog natjecanja. Jednostavno zaključavanje DELETE-a moglo bi razbiti postojeći UX.

Ako aplikacija počne kružiti šire, planirana jednostavna zaštita je prvenstveno **organizatorska šifra / zaštita kreiranja novih natjecanja**, dok vagari trebaju ostati što jednostavniji i bez registracije. Za stvarno jaču sigurnost kasnije treba osmisliti organizer token/auth/RPC model i zatim stegnuti RLS.

## 11. Privatnost i tajne

Frontend koristi:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_KEY`

To su Vite varijable i browser ih vidi. Supabase URL + anon/publishable key nisu service-role tajna; sigurnost mora dolaziti iz RLS/RPC pravila.

**Nikada:**
- ne commitati `.env`;
- ne stavljati Supabase service-role/secret key u frontend;
- ne zapisivati admin lozinku u repo/handoff;
- ne tražiti od Luke da šalje tajne u chat ako nije nužno.

## 12. Branding

Aplikacija koristi branding:
- **Created by Luka Jurak**

Branding je dodan u:
- vidljivi rezultat;
- printable view / PNG;
- PDF footer.

Ne uklanjati ga slučajno pri refaktoru exporta.

Glavni naslov:
- **Program za izračun rezultata**

Vidljivi subtitle je namjerno discipline-neutral:
- **Bodovanje ribolovnih natjecanja**

Raniji tekst je spominjao feeder, ali je uklonjen jer aplikacija nije zamišljena samo za feeder.

## 13. Produktne odluke do sada

### Što želimo sada
Aplikaciju nastaviti prilagođavati našim stvarnim potrebama na natjecanjima. Fokus je funkcionalnost, pouzdanost i jednostavnost.

### Što ostaje u planu
Statistika jednog natjecanja, primjerice:
- ukupan ulov;
- prosjeci;
- usporedba sektora;
- statistika ekipa;
- najveći ulovi;
- kasnije prikladni grafovi.

To još nije konačno specificirano. **Ne implementirati statistiku samo zato što je navedena ovdje.** Prvo s Lukom definirati što mu je stvarno korisno.

### Što zasad NE gradimo
Ne gradimo veliki dugoročni analitički sustav za:
- povijest svih voda;
- višegodišnje lige;
- univerzalne profile klubova/ekipa;
- globalnu platformu za sve organizatore.

Razlog: aplikacija će zasad služiti našem krugu i takva infrastruktura nema dovoljno koristi za dodatnu kompleksnost.

### Potencijalni proizvod jednog dana
Mogućnost nije odbačena. Upravo zato postoji backup branch `osnovni-kostur-2026-09-21`. Ako jednog dana odlučimo napraviti proizvod za širu publiku, radije krenuti od tog kostura i svjesno dizajnirati multi-organizer/multi-format arhitekturu nego pokušavati očistiti sve lokalne specifičnosti iz budućeg `main`a.

## 14. UX filozofija

Najvažniji korisnici tijekom natjecanja nisu developeri nego ljudi s mobitelima na vodi.

Prioriteti:
- što manje koraka;
- veliki i jasni inputi;
- brzo unošenje;
- bez obavezne registracije vagara;
- jasan status sinkronizacije;
- otpornost na slab internet;
- ne zatrpavati ekran statistikama tijekom vaganja;
- rezultat mora biti lako provjerljiv i izvoziv.

Ako napredna funkcija narušava unos na terenu, odvojiti je u zaseban ekran umjesto da optereti osnovni workflow.

## 15. Pravilo za scoring

Scoring je kritična domena. Ne mijenjati formule ili tretman statusa na temelju pretpostavke o pravilima ribolova.

Kod svake promjene koja utječe na plasman:
1. pročitati `src/scoring.ts` i postojeće testove;
2. tražiti od Luke konkretno pravilo ako je išta nejasno;
3. napraviti test primjere;
4. provjeriti tie-breakove i statuse;
5. tek onda deploy.

Vizualni feature ne smije nenamjerno promijeniti rezultat.

## 16. Deploy i provjera

GitHub `main` je spojen na Vercel production. Commit može automatski pokrenuti deploy.

Za ozbiljniji zahvat ne završavati posao samo zato što je commit napravljen. Provjeriti:
- build/test/lint gdje je izvedivo;
- Vercel deployment status;
- produkcijsku rutu;
- ako je diran Supabase, stvarnu DB strukturu/politike/RPC;
- ako je diran scoring, testove rezultata.

Ne tvrditi da je nešto deployano/READY dok status nije provjeren.

## 17. Kako Work treba pristupiti budućim zadacima

Ovaj dokument je kontekst, ali **repo i stvarna infrastruktura su source of truth**. Prije izmjene:
- pregledati aktualni `main`;
- provjeriti je li ovaj handoff zastario;
- za DB promjene provjeriti stvarni Supabase schema/migrations/policies;
- za deployment provjeriti Vercel;
- ne pretpostavljati da se stanje nije promijenilo.

Kod većeg featurea prvo kratko opisati Luki:
- što će korisnik vidjeti/raditi;
- koje postojeće dijelove feature dira;
- postoji li rizik za scoring, sync ili podatke.

Zatim implementirati.

## 18. Poznati arhitektonski dug

Najvažniji dug nije estetika nego authorization model.

Trenutni anonymous-first workflow je vrlo praktičan, ali permisivni RLS znači da sama skrivenost admin stranice nije sigurnosna granica. Kako se krug korisnika bude širio, ovo treba ponovno procijeniti.

Drugi dug je da je core trenutno čvrsto vezan uz A/B/C model. To je prihvatljivo za naše potrebe. Ne generalizirati prerano.

Treći budući problem, ako uvedemo povijest, jest da sadašnji 7-day TTL namjerno briše operativne podatke. Povijest/statistika treba dobiti zasebno promišljen lifecycle.

## 19. Trenutni smjer razvoja

Najnovija odluka:
- sačuvan je čisti kostur u zasebnom branchu;
- `main` se smije dalje prilagođavati našim potrebama;
- prije svake veće funkcije promisliti workflow i redoslijed;
- statistika ostaje kandidat za kasnije;
- prvo graditi konkretne značajke koje Luka i njegov krug stvarno trebaju.

**Ne pokušavati unaprijed pretvoriti projekt u SaaS.**

## 20. Napomena budućem agentu

Nemoj ovaj projekt tretirati samo kao kodni zadatak. Mnogo odluka proizlazi iz stvarnog procesa ribolovnog natjecanja. Kada tehnički elegantno rješenje povećava broj koraka vagaru ili organizatoru, ono možda nije bolje rješenje.

Cilj je: **jednostavan alat na terenu, točan rezultat, pouzdana sinkronizacija i mogućnost postupnog dodavanja korisnih funkcija bez lomljenja corea.**
