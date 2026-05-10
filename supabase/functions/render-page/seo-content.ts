/**
 * SEO content helpers for render-page (bot-visible HTML).
 *
 * All content here is deterministic (slug + lang) so no DB call is needed.
 * Used to give crawlers 600+ words of unique content per city/trainer/region/club/academy
 * page and emit FAQPage schemas for rich-result eligibility.
 */

const SITE_URL = 'https://padeltrainer.ai';

// ─── Popular cities (used for internal-link blocks) ─────────────
// Hand-curated list — kept in render-page (no DB) to keep responses fast.
export const POPULAR_CITIES: Array<{ slug: string; name: string; country: string }> = [
  { slug: 'amsterdam', name: 'Amsterdam', country: 'NL' },
  { slug: 'rotterdam', name: 'Rotterdam', country: 'NL' },
  { slug: 'utrecht', name: 'Utrecht', country: 'NL' },
  { slug: 'eindhoven', name: 'Eindhoven', country: 'NL' },
  { slug: 'den-haag', name: 'Den Haag', country: 'NL' },
  { slug: 'madrid', name: 'Madrid', country: 'ES' },
  { slug: 'barcelona', name: 'Barcelona', country: 'ES' },
  { slug: 'valencia', name: 'Valencia', country: 'ES' },
  { slug: 'sevilla', name: 'Sevilla', country: 'ES' },
  { slug: 'malaga', name: 'Málaga', country: 'ES' },
  { slug: 'marbella', name: 'Marbella', country: 'ES' },
  { slug: 'munchen', name: 'München', country: 'DE' },
  { slug: 'koln', name: 'Köln', country: 'DE' },
  { slug: 'berlin', name: 'Berlin', country: 'DE' },
  { slug: 'hamburg', name: 'Hamburg', country: 'DE' },
  { slug: 'paris', name: 'Paris', country: 'FR' },
  { slug: 'lyon', name: 'Lyon', country: 'FR' },
  { slug: 'milano', name: 'Milano', country: 'IT' },
  { slug: 'roma', name: 'Roma', country: 'IT' },
  { slug: 'antwerpen', name: 'Antwerpen', country: 'BE' },
  { slug: 'brussels', name: 'Brussels', country: 'BE' },
  { slug: 'lisboa', name: 'Lisboa', country: 'PT' },
];

export const POPULAR_REGIONS: Array<{ slug: string; name: string }> = [
  { slug: 'noord-holland', name: 'Noord-Holland' },
  { slug: 'zuid-holland', name: 'Zuid-Holland' },
  { slug: 'noord-brabant', name: 'Noord-Brabant' },
  { slug: 'utrecht', name: 'Utrecht' },
  { slug: 'cataluna', name: 'Cataluña' },
  { slug: 'comunidad-de-madrid', name: 'Comunidad de Madrid' },
  { slug: 'andalucia', name: 'Andalucía' },
  { slug: 'bayern', name: 'Bayern' },
  { slug: 'nordrhein-westfalen', name: 'Nordrhein-Westfalen' },
];

// ─── i18n strings (per locale) ──────────────────────────────────
type L = 'en' | 'nl' | 'es' | 'de' | 'fr' | 'it';
function pick<T>(lang: string, map: Record<L, T>): T {
  return map[(lang as L)] ?? map.en;
}

// ─── FAQ generators (return [{question, answer}, ...]) ──────────

export function cityFaqs(city: string, lang: string): Array<{ question: string; answer: string }> {
  return pick<Array<{ question: string; answer: string }>>(lang, {
    en: [
      { question: `How much does a padel lesson in ${city} cost?`, answer: `Padel lessons in ${city} typically range from €40 to €90 per hour, depending on the trainer's experience, certification level, and whether you book a private or group lesson. Most trainers on PadelTrainer.ai display their hourly rate publicly, so you can compare before booking.` },
      { question: `How do I book a padel trainer in ${city}?`, answer: `Browse certified padel trainers in ${city} above, click any trainer profile to see their availability, and book directly through PadelTrainer.ai. You'll see real-time slots, transparent pricing, and verified reviews from past players.` },
      { question: `Are padel trainers in ${city} certified?`, answer: `Many trainers listed in ${city} hold official padel coaching certifications (FIP, MEP, federation diplomas). We display every trainer's credentials, experience, and verified reviews so you can choose with confidence.` },
      { question: `Can beginners take padel lessons in ${city}?`, answer: `Yes. Most ${city} trainers offer beginner-friendly programs covering grip, footwork, basic strokes, and game rules. Filter by "Beginners" specialization to find coaches with proven beginner experience.` },
      { question: `Do trainers in ${city} offer group lessons?`, answer: `Group lessons (2-4 players) are widely available in ${city} and typically cost 40-60% less per person than private lessons. Look for trainers with "Group Lessons" in their specializations.` },
      { question: `What's the best time to book a padel lesson in ${city}?`, answer: `Weekday mornings and early afternoons offer the best availability and often discounted rates. Weekends and evenings book up fastest — reserve at least a week in advance for prime slots.` },
    ],
    nl: [
      { question: `Hoeveel kost een padelles in ${city}?`, answer: `Padellessen in ${city} kosten meestal tussen €40 en €90 per uur, afhankelijk van ervaring, certificering en of je een privé- of groepsles boekt. De meeste trainers op PadelTrainer.ai tonen hun uurtarief openbaar zodat je kunt vergelijken voor je boekt.` },
      { question: `Hoe boek ik een padeltrainer in ${city}?`, answer: `Bekijk gecertificeerde padeltrainers in ${city} hierboven, klik op een profiel om beschikbaarheid te zien en boek direct via PadelTrainer.ai. Je ziet realtime tijdsloten, transparante prijzen en geverifieerde reviews.` },
      { question: `Zijn padeltrainers in ${city} gecertificeerd?`, answer: `Veel trainers in ${city} hebben officiële padelcoachdiploma's (FIP, MEP, KNLTB). Per trainer tonen we de kwalificaties, ervaring en reviews zodat je met vertrouwen kunt kiezen.` },
      { question: `Kunnen beginners padelles nemen in ${city}?`, answer: `Ja. De meeste ${city}-trainers bieden beginnersprogramma's met grip, voetenwerk, basisslagen en spelregels. Filter op "Beginners" om coaches te vinden met bewezen ervaring.` },
      { question: `Bieden trainers in ${city} groepslessen aan?`, answer: `Groepslessen (2-4 spelers) zijn breed beschikbaar in ${city} en kosten meestal 40-60% minder per persoon dan privélessen. Zoek naar trainers met "Groepslessen" in hun specialisaties.` },
      { question: `Wat is het beste moment om een padelles te boeken in ${city}?`, answer: `Doordeweekse ochtenden en vroege middagen hebben de beste beschikbaarheid en vaak korting. Avonden en weekends zijn snel volgeboekt — reserveer minstens een week vooruit.` },
    ],
    es: [
      { question: `¿Cuánto cuesta una clase de pádel en ${city}?`, answer: `Las clases de pádel en ${city} suelen costar entre €40 y €90 por hora, según la experiencia del entrenador, su titulación y si reservas clase privada o grupal. La mayoría de entrenadores en PadelTrainer.ai muestra su tarifa públicamente para que puedas comparar antes de reservar.` },
      { question: `¿Cómo reservo un entrenador de pádel en ${city}?`, answer: `Explora entrenadores certificados de pádel en ${city}, haz clic en un perfil para ver disponibilidad y reserva directamente. Verás horarios en tiempo real, precios claros y reseñas verificadas.` },
      { question: `¿Los entrenadores en ${city} están certificados?`, answer: `Muchos entrenadores en ${city} cuentan con titulaciones oficiales (FIP, MEP, federaciones). Mostramos las credenciales, experiencia y reseñas de cada uno para que elijas con confianza.` },
      { question: `¿Pueden los principiantes recibir clases de pádel en ${city}?`, answer: `Sí. La mayoría de entrenadores en ${city} ofrecen programas para principiantes con empuñadura, juego de pies, golpes básicos y reglas. Filtra por "Principiantes" para encontrar coaches con experiencia.` },
      { question: `¿Ofrecen clases grupales los entrenadores en ${city}?`, answer: `Las clases grupales (2-4 jugadores) están ampliamente disponibles en ${city} y suelen costar un 40-60% menos por persona que las privadas. Busca entrenadores con "Clases en Grupo" en sus especialidades.` },
      { question: `¿Cuál es el mejor momento para reservar una clase de pádel en ${city}?`, answer: `Las mañanas y primeras horas de la tarde entre semana ofrecen mejor disponibilidad y, a veces, descuentos. Las tardes y fines de semana se agotan rápido; reserva al menos una semana antes.` },
    ],
    de: [
      { question: `Was kostet eine Padel-Stunde in ${city}?`, answer: `Padel-Stunden in ${city} kosten in der Regel zwischen 40 € und 90 € pro Stunde, abhängig von Erfahrung, Lizenz und ob du Einzel- oder Gruppentraining buchst. Die meisten Trainer auf PadelTrainer.ai zeigen ihren Stundensatz öffentlich, sodass du vor dem Buchen vergleichen kannst.` },
      { question: `Wie buche ich einen Padel-Trainer in ${city}?`, answer: `Stöbere durch zertifizierte Padel-Trainer in ${city}, öffne ein Profil für Verfügbarkeit und buche direkt über PadelTrainer.ai. Du siehst Echtzeit-Slots, transparente Preise und verifizierte Bewertungen.` },
      { question: `Sind Padel-Trainer in ${city} zertifiziert?`, answer: `Viele Trainer in ${city} besitzen offizielle Padel-Lizenzen (FIP, MEP, Verbandstrainer). Wir zeigen für jeden Trainer Qualifikationen, Erfahrung und Bewertungen.` },
      { question: `Können Anfänger in ${city} Padel-Stunden nehmen?`, answer: `Ja. Die meisten Trainer in ${city} bieten Anfängerprogramme mit Griff, Beinarbeit, Grundschlägen und Spielregeln. Filtere nach "Anfänger", um geeignete Coaches zu finden.` },
      { question: `Bieten Trainer in ${city} Gruppentraining an?`, answer: `Gruppentraining (2-4 Spieler) ist in ${city} weit verbreitet und kostet pro Person meist 40-60% weniger als Einzeltraining. Suche nach Trainern mit "Gruppentraining" in den Spezialisierungen.` },
      { question: `Wann ist die beste Zeit, eine Padel-Stunde in ${city} zu buchen?`, answer: `Werktags vormittags und am frühen Nachmittag gibt es die beste Verfügbarkeit und häufig Rabatte. Abende und Wochenenden sind schnell ausgebucht — buche mindestens eine Woche im Voraus.` },
    ],
    fr: [
      { question: `Combien coûte un cours de padel à ${city} ?`, answer: `Les cours de padel à ${city} coûtent généralement entre 40 € et 90 € de l'heure, selon l'expérience du coach, sa certification et le format (privé ou collectif). La plupart des coachs sur PadelTrainer.ai affichent leur tarif horaire publiquement.` },
      { question: `Comment réserver un coach de padel à ${city} ?`, answer: `Parcourez les coachs certifiés à ${city}, ouvrez un profil pour voir les disponibilités et réservez directement via PadelTrainer.ai. Vous verrez les créneaux en temps réel, des prix transparents et des avis vérifiés.` },
      { question: `Les coachs à ${city} sont-ils certifiés ?`, answer: `De nombreux coachs à ${city} sont titulaires de diplômes officiels (FIP, MEP, fédéraux). Nous affichons les qualifications, l'expérience et les avis pour chaque coach.` },
      { question: `Les débutants peuvent-ils prendre des cours à ${city} ?`, answer: `Oui. La plupart des coachs à ${city} proposent des programmes débutants couvrant la prise, les déplacements, les coups de base et les règles. Filtrez par "Débutants" pour trouver les coachs adaptés.` },
      { question: `Y a-t-il des cours collectifs à ${city} ?`, answer: `Les cours collectifs (2 à 4 joueurs) sont largement disponibles à ${city} et coûtent généralement 40 à 60% moins cher par personne que les cours privés.` },
      { question: `Quel est le meilleur moment pour réserver un cours à ${city} ?`, answer: `Les matinées et débuts d'après-midi en semaine offrent la meilleure disponibilité et parfois des tarifs réduits. Les soirées et week-ends se remplissent vite — réservez au moins une semaine à l'avance.` },
    ],
    it: [
      { question: `Quanto costa una lezione di padel a ${city}?`, answer: `Le lezioni di padel a ${city} costano in genere tra 40 € e 90 € all'ora, a seconda dell'esperienza, della certificazione del maestro e se prenoti una lezione individuale o di gruppo.` },
      { question: `Come prenoto un maestro di padel a ${city}?`, answer: `Sfoglia i maestri certificati a ${city}, apri un profilo per vedere disponibilità e prezzi e prenota direttamente su PadelTrainer.ai.` },
      { question: `I maestri a ${city} sono certificati?`, answer: `Molti maestri a ${city} possiedono certificazioni ufficiali (FIP, MEP, federali). Mostriamo qualifiche, esperienza e recensioni di ciascuno.` },
      { question: `I principianti possono prendere lezioni a ${city}?`, answer: `Sì. La maggior parte dei maestri a ${city} offre programmi per principianti su impugnatura, movimento, colpi base e regole.` },
      { question: `Ci sono lezioni di gruppo a ${city}?`, answer: `Lezioni di gruppo (2-4 giocatori) sono molto diffuse a ${city} e costano in genere il 40-60% in meno per persona rispetto alle lezioni individuali.` },
      { question: `Qual è il momento migliore per prenotare a ${city}?`, answer: `Le mattine e i primi pomeriggi infrasettimanali offrono la migliore disponibilità e spesso sconti. Le sere e i weekend si esauriscono rapidamente.` },
    ],
  });
}

export function trainerFaqs(name: string, lang: string): Array<{ question: string; answer: string }> {
  return pick<Array<{ question: string; answer: string }>>(lang, {
    en: [
      { question: `How do I book a lesson with ${name}?`, answer: `Open ${name}'s profile, choose an available time slot from the calendar, and complete payment securely through PadelTrainer.ai. You'll receive instant confirmation by email.` },
      { question: `What experience does ${name} have?`, answer: `Each trainer profile shows years of coaching experience, certifications (FIP, MEP, federation), specializations, and verified reviews from past players.` },
      { question: `Can I cancel or reschedule a lesson with ${name}?`, answer: `Yes. Most trainers allow free cancellation up to 24 hours before the lesson. Specific cancellation terms are visible on the booking page before you confirm payment.` },
      { question: `Does ${name} offer group lessons?`, answer: `Check the "Specializations" section of the profile — trainers offering group, private, junior or competition coaching list it explicitly.` },
    ],
    nl: [
      { question: `Hoe boek ik een les bij ${name}?`, answer: `Open het profiel van ${name}, kies een beschikbaar tijdslot uit de kalender en betaal veilig via PadelTrainer.ai. Je krijgt direct een bevestiging per e-mail.` },
      { question: `Welke ervaring heeft ${name}?`, answer: `Op elk trainersprofiel vind je het aantal jaren ervaring, certificeringen (FIP, MEP, KNLTB), specialisaties en geverifieerde reviews.` },
      { question: `Kan ik een les bij ${name} annuleren of verzetten?`, answer: `Ja. De meeste trainers staan gratis annuleren toe tot 24 uur voor de les. De specifieke voorwaarden zie je op de boekingspagina voordat je betaalt.` },
      { question: `Geeft ${name} groepslessen?`, answer: `Bekijk de "Specialisaties" op het profiel — trainers die groeps-, privé-, jeugd- of wedstrijdtraining geven, vermelden dit duidelijk.` },
    ],
    es: [
      { question: `¿Cómo reservo una clase con ${name}?`, answer: `Abre el perfil de ${name}, elige un horario disponible y completa el pago de forma segura. Recibirás confirmación inmediata por correo.` },
      { question: `¿Qué experiencia tiene ${name}?`, answer: `Cada perfil muestra años de experiencia, titulaciones (FIP, MEP, federación), especialidades y reseñas verificadas.` },
      { question: `¿Puedo cancelar o cambiar una clase con ${name}?`, answer: `Sí. La mayoría de entrenadores permite cancelación gratuita hasta 24 horas antes. Las condiciones aparecen en la página de reserva.` },
      { question: `¿${name} ofrece clases grupales?`, answer: `Mira la sección "Especialidades" — los entrenadores que ofrecen clases grupales, privadas, junior o de competición lo indican claramente.` },
    ],
    de: [
      { question: `Wie buche ich eine Stunde bei ${name}?`, answer: `Öffne das Profil von ${name}, wähle einen freien Termin aus dem Kalender und zahle sicher über PadelTrainer.ai. Du erhältst sofort eine E-Mail-Bestätigung.` },
      { question: `Welche Erfahrung hat ${name}?`, answer: `Jedes Trainerprofil zeigt Jahre an Erfahrung, Lizenzen (FIP, MEP, Verband), Spezialisierungen und verifizierte Bewertungen.` },
      { question: `Kann ich eine Stunde stornieren oder verschieben?`, answer: `Ja. Die meisten Trainer erlauben kostenlose Stornierung bis 24 Stunden vorher. Die genauen Bedingungen siehst du vor der Buchung.` },
      { question: `Bietet ${name} Gruppentraining?`, answer: `Sieh dir den Abschnitt "Spezialisierungen" an — Trainer, die Gruppen-, Einzel-, Jugend- oder Wettkampftraining anbieten, weisen dies aus.` },
    ],
    fr: [
      { question: `Comment réserver un cours avec ${name} ?`, answer: `Ouvrez le profil de ${name}, choisissez un créneau disponible et finalisez le paiement en toute sécurité. Vous recevrez une confirmation immédiate par e-mail.` },
      { question: `Quelle est l'expérience de ${name} ?`, answer: `Chaque profil affiche les années d'expérience, les diplômes (FIP, MEP, fédéraux), les spécialisations et les avis vérifiés.` },
      { question: `Puis-je annuler ou reporter un cours ?`, answer: `Oui. La plupart des coachs autorisent l'annulation gratuite jusqu'à 24 heures avant le cours. Les conditions sont affichées avant le paiement.` },
      { question: `${name} propose-t-il des cours collectifs ?`, answer: `Consultez la section "Spécialisations" — les coachs qui proposent collectif, privé, junior ou compétition l'indiquent clairement.` },
    ],
    it: [
      { question: `Come prenoto una lezione con ${name}?`, answer: `Apri il profilo di ${name}, scegli un orario disponibile e completa il pagamento in sicurezza. Riceverai conferma immediata via email.` },
      { question: `Che esperienza ha ${name}?`, answer: `Ogni profilo mostra anni di esperienza, certificazioni (FIP, MEP, federali), specializzazioni e recensioni verificate.` },
      { question: `Posso annullare o spostare una lezione?`, answer: `Sì. La maggior parte dei maestri consente cancellazioni gratuite fino a 24 ore prima.` },
      { question: `${name} offre lezioni di gruppo?`, answer: `Controlla la sezione "Specializzazioni" — i maestri che offrono gruppo, privato, junior o agonistico lo indicano chiaramente.` },
    ],
  });
}

export function clubFaqs(name: string, lang: string): Array<{ question: string; answer: string }> {
  return pick<Array<{ question: string; answer: string }>>(lang, {
    en: [
      { question: `How do I book a court at ${name}?`, answer: `${name} is listed on PadelTrainer.ai with all available trainers, courts and amenities. Pick a coach and book through their profile to play here.` },
      { question: `Does ${name} have indoor and outdoor padel courts?`, answer: `Court counts (indoor + outdoor) and amenities are listed in the club profile above. Both types are common at modern padel venues.` },
      { question: `Can beginners play at ${name}?`, answer: `Yes — most clubs welcome players of all levels and many resident trainers run beginner programs.` },
      { question: `Are padel lessons available at ${name}?`, answer: `Yes. Browse the trainers listed at this club above and book lessons directly with your preferred coach.` },
    ],
    nl: [
      { question: `Hoe boek ik een baan bij ${name}?`, answer: `${name} staat vermeld op PadelTrainer.ai met alle beschikbare trainers, banen en voorzieningen. Kies een coach en boek via het profiel om hier te spelen.` },
      { question: `Heeft ${name} indoor en outdoor padelbanen?`, answer: `Het aantal banen (indoor + outdoor) en voorzieningen staat hierboven in het clubprofiel. Beide typen zijn gebruikelijk bij moderne padelaccommodaties.` },
      { question: `Kunnen beginners spelen bij ${name}?`, answer: `Ja, de meeste clubs verwelkomen spelers van alle niveaus en veel trainers bieden beginnersprogramma's.` },
      { question: `Zijn er padellessen beschikbaar bij ${name}?`, answer: `Ja. Bekijk de trainers die bij deze club werken en boek lessen direct bij je favoriete coach.` },
    ],
    es: [
      { question: `¿Cómo reservo una pista en ${name}?`, answer: `${name} está listado en PadelTrainer.ai con todos los entrenadores y servicios disponibles. Elige un coach y reserva a través de su perfil para jugar aquí.` },
      { question: `¿${name} tiene pistas indoor y outdoor?`, answer: `El número de pistas y servicios aparece arriba en el perfil del club. Ambos tipos son habituales en clubes modernos.` },
      { question: `¿Pueden jugar los principiantes en ${name}?`, answer: `Sí, la mayoría de clubes da la bienvenida a jugadores de todos los niveles y muchos entrenadores ofrecen programas para principiantes.` },
      { question: `¿Hay clases de pádel en ${name}?`, answer: `Sí. Mira los entrenadores listados en este club y reserva clases directamente con tu coach preferido.` },
    ],
    de: [
      { question: `Wie buche ich einen Court bei ${name}?`, answer: `${name} ist auf PadelTrainer.ai gelistet inkl. aller Trainer und Ausstattung. Wähle einen Coach und buche über sein Profil, um hier zu spielen.` },
      { question: `Hat ${name} Indoor- und Outdoor-Padel-Courts?`, answer: `Anzahl der Courts (Indoor + Outdoor) und Ausstattung findest du oben im Clubprofil. Beide Typen sind in modernen Anlagen üblich.` },
      { question: `Können Anfänger bei ${name} spielen?`, answer: `Ja, die meisten Clubs heißen alle Spielstärken willkommen und viele ansässige Trainer bieten Anfängerprogramme an.` },
      { question: `Gibt es bei ${name} Padel-Unterricht?`, answer: `Ja. Sieh dir die Trainer dieses Clubs an und buche Stunden direkt bei deinem Wunsch-Coach.` },
    ],
    fr: [
      { question: `Comment réserver un terrain à ${name} ?`, answer: `${name} est référencé sur PadelTrainer.ai avec tous les coachs disponibles. Choisissez un coach et réservez via son profil pour jouer ici.` },
      { question: `${name} a-t-il des terrains indoor et outdoor ?`, answer: `Le nombre de terrains (intérieurs + extérieurs) et les services figurent ci-dessus dans le profil du club.` },
      { question: `Les débutants peuvent-ils jouer à ${name} ?`, answer: `Oui, la plupart des clubs accueillent tous les niveaux et beaucoup de coachs proposent des programmes débutants.` },
      { question: `Y a-t-il des cours de padel à ${name} ?`, answer: `Oui. Consultez les coachs de ce club ci-dessus et réservez directement avec votre coach préféré.` },
    ],
    it: [
      { question: `Come prenoto un campo a ${name}?`, answer: `${name} è presente su PadelTrainer.ai con tutti i maestri disponibili. Scegli un coach e prenota dal suo profilo per giocare qui.` },
      { question: `${name} ha campi indoor e outdoor?`, answer: `Numero di campi e servizi sono indicati nel profilo del club qui sopra.` },
      { question: `I principianti possono giocare a ${name}?`, answer: `Sì, la maggior parte dei club accoglie giocatori di tutti i livelli.` },
      { question: `Ci sono lezioni di padel a ${name}?`, answer: `Sì. Sfoglia i maestri presenti in questo club e prenota lezioni direttamente.` },
    ],
  });
}

export function academyFaqs(name: string, lang: string): Array<{ question: string; answer: string }> {
  return pick<Array<{ question: string; answer: string }>>(lang, {
    en: [
      { question: `What programs does ${name} offer?`, answer: `${name} runs structured padel programs ranging from beginner clinics to competitive squad training. Browse the open cycles and trainers above to view current offerings.` },
      { question: `How do I register for a course at ${name}?`, answer: `Pick an open cycle from the schedule above and follow the registration steps. You'll be matched with a slot that fits your level and availability.` },
      { question: `What's the difference between an academy and a single trainer?`, answer: `Academies coordinate multiple coaches, training cycles and player levels — ideal for ongoing structured improvement. Individual trainers offer flexible one-off sessions.` },
      { question: `Are sessions at ${name} suitable for all levels?`, answer: `Yes — most academies offer parallel groups for beginners, intermediate and advanced players. Filter the open cycles by level to find your match.` },
    ],
    nl: [
      { question: `Welke programma's biedt ${name}?`, answer: `${name} organiseert gestructureerde padelprogramma's van beginnersclinics tot competitieve squadtraining. Bekijk de open cyclussen en trainers hierboven.` },
      { question: `Hoe meld ik me aan voor een cursus bij ${name}?`, answer: `Kies een open cyclus uit het schema hierboven en volg de aanmeldstappen. Je wordt gekoppeld aan een slot dat past bij je niveau en beschikbaarheid.` },
      { question: `Wat is het verschil tussen een academy en een individuele trainer?`, answer: `Academies coördineren meerdere coaches, cycli en spelersniveaus — ideal voor doorlopende ontwikkeling. Individuele trainers bieden flexibele losse sessies.` },
      { question: `Zijn de sessies bij ${name} geschikt voor alle niveaus?`, answer: `Ja — de meeste academies bieden parallelle groepen voor beginners, gemiddeld en gevorderd. Filter de open cyclussen op niveau.` },
    ],
    es: [
      { question: `¿Qué programas ofrece ${name}?`, answer: `${name} organiza programas estructurados de pádel desde clinics para principiantes hasta entrenamiento competitivo. Mira los ciclos abiertos y entrenadores arriba.` },
      { question: `¿Cómo me inscribo en un curso de ${name}?`, answer: `Elige un ciclo abierto en el calendario y sigue los pasos. Te asignaremos a un grupo según tu nivel y disponibilidad.` },
      { question: `¿Cuál es la diferencia entre una academia y un entrenador individual?`, answer: `Las academias coordinan varios coaches, ciclos y niveles — ideal para mejora continua. Los entrenadores individuales ofrecen sesiones puntuales más flexibles.` },
      { question: `¿Las sesiones en ${name} son aptas para todos los niveles?`, answer: `Sí — la mayoría de academias ofrece grupos paralelos para principiantes, intermedio y avanzado.` },
    ],
    de: [
      { question: `Welche Programme bietet ${name}?`, answer: `${name} organisiert strukturierte Padel-Programme von Anfänger-Clinics bis hin zu Wettkampftraining. Sieh dir die offenen Zyklen und Trainer oben an.` },
      { question: `Wie melde ich mich für einen Kurs bei ${name} an?`, answer: `Wähle einen offenen Zyklus aus dem Plan und folge den Anmeldeschritten. Wir ordnen dich einer Gruppe nach Niveau und Verfügbarkeit zu.` },
      { question: `Was ist der Unterschied zwischen Akademie und Einzeltrainer?`, answer: `Akademien koordinieren mehrere Coaches, Zyklen und Spielniveaus — ideal für strukturierte Entwicklung. Einzeltrainer bieten flexible Einzelsessions.` },
      { question: `Sind die Einheiten bei ${name} für alle Niveaus geeignet?`, answer: `Ja — die meisten Akademien bieten parallele Gruppen für Anfänger, Mittelstufe und Fortgeschrittene.` },
    ],
    fr: [
      { question: `Quels programmes propose ${name} ?`, answer: `${name} propose des programmes structurés du clinic débutant au cycle compétition. Consultez les cycles ouverts et les coachs ci-dessus.` },
      { question: `Comment s'inscrire à un cours chez ${name} ?`, answer: `Choisissez un cycle ouvert dans le planning et suivez les étapes d'inscription. Nous vous attribuerons un créneau correspondant à votre niveau.` },
      { question: `Quelle différence entre une académie et un coach individuel ?`, answer: `Les académies coordonnent plusieurs coachs, cycles et niveaux — idéal pour une progression structurée. Les coachs individuels offrent des séances ponctuelles plus flexibles.` },
      { question: `Les séances chez ${name} conviennent-elles à tous les niveaux ?`, answer: `Oui — la plupart des académies proposent des groupes parallèles débutant, intermédiaire et avancé.` },
    ],
    it: [
      { question: `Quali programmi offre ${name}?`, answer: `${name} organizza programmi strutturati dal clinic per principianti al training agonistico. Guarda i cicli aperti e i maestri qui sopra.` },
      { question: `Come mi iscrivo a un corso di ${name}?`, answer: `Scegli un ciclo aperto dal calendario e segui i passaggi. Verrai assegnato a un gruppo in base al livello.` },
      { question: `Qual è la differenza tra accademia e maestro singolo?`, answer: `Le accademie coordinano più coach, cicli e livelli — ideale per crescita continua. I maestri singoli offrono lezioni puntuali più flessibili.` },
      { question: `Le sessioni a ${name} sono per tutti i livelli?`, answer: `Sì — la maggior parte delle accademie offre gruppi paralleli per principianti, intermedi e avanzati.` },
    ],
  });
}

export function regionFaqs(region: string, lang: string): Array<{ question: string; answer: string }> {
  return pick<Array<{ question: string; answer: string }>>(lang, {
    en: [
      { question: `Where can I find padel trainers in ${region}?`, answer: `Browse the cities in ${region} above. Each city links to certified trainers, padel clubs and academies in that area.` },
      { question: `How many padel clubs are in ${region}?`, answer: `Padel is one of the fastest-growing sports in ${region}. The city listings above show the current count of trainers and venues per city.` },
      { question: `What's the average price for padel lessons in ${region}?`, answer: `Lessons typically range €40-€90/hour across ${region}, with metropolitan areas trending higher and smaller cities lower.` },
    ],
    nl: [
      { question: `Waar vind ik padeltrainers in ${region}?`, answer: `Bekijk de steden in ${region} hierboven. Elke stad linkt naar gecertificeerde trainers, padelclubs en academies in dat gebied.` },
      { question: `Hoeveel padelclubs zijn er in ${region}?`, answer: `Padel is een van de snelst groeiende sporten in ${region}. De stadslijst hierboven toont het huidige aantal trainers en clubs per stad.` },
      { question: `Wat is de gemiddelde prijs van padellessen in ${region}?`, answer: `Lessen kosten doorgaans €40-€90/uur in ${region}; grootstedelijke gebieden zitten hoger, kleinere steden lager.` },
    ],
    es: [
      { question: `¿Dónde encuentro entrenadores de pádel en ${region}?`, answer: `Explora las ciudades de ${region} arriba. Cada ciudad enlaza con entrenadores certificados, clubes y academias.` },
      { question: `¿Cuántos clubes de pádel hay en ${region}?`, answer: `El pádel es uno de los deportes de mayor crecimiento en ${region}. La lista de ciudades muestra el número de entrenadores y clubes.` },
      { question: `¿Cuál es el precio medio de las clases en ${region}?`, answer: `Las clases suelen costar entre €40-€90/hora en ${region}; las áreas metropolitanas tienden a ser más caras.` },
    ],
    de: [
      { question: `Wo finde ich Padel-Trainer in ${region}?`, answer: `Sieh dir die Städte in ${region} oben an. Jede Stadt verlinkt zu zertifizierten Trainern, Clubs und Akademien.` },
      { question: `Wie viele Padel-Clubs gibt es in ${region}?`, answer: `Padel ist eine der am schnellsten wachsenden Sportarten in ${region}. Die Städteliste zeigt die aktuelle Anzahl an Trainern und Clubs.` },
      { question: `Was kostet eine Padel-Stunde in ${region} im Schnitt?`, answer: `Stunden kosten in ${region} meist 40-90 €; in Metropolen tendenziell höher.` },
    ],
    fr: [
      { question: `Où trouver des coachs de padel à ${region} ?`, answer: `Parcourez les villes de ${region} ci-dessus. Chaque ville renvoie aux coachs certifiés, clubs et académies de la zone.` },
      { question: `Combien de clubs de padel y a-t-il à ${region} ?`, answer: `Le padel est l'un des sports à plus forte croissance dans ${region}. La liste des villes affiche le nombre actuel de coachs et de clubs.` },
      { question: `Quel est le prix moyen d'un cours à ${region} ?`, answer: `Les cours coûtent généralement entre 40 € et 90 €/heure à ${region}, plus chers dans les métropoles.` },
    ],
    it: [
      { question: `Dove trovo maestri di padel a ${region}?`, answer: `Sfoglia le città di ${region} qui sopra. Ogni città rimanda a maestri certificati, club e accademie.` },
      { question: `Quanti club di padel ci sono in ${region}?`, answer: `Il padel è uno degli sport in più rapida crescita in ${region}. La lista delle città mostra il numero corrente di maestri e club.` },
      { question: `Qual è il prezzo medio di una lezione a ${region}?`, answer: `Le lezioni costano in genere tra 40 € e 90 €/ora in ${region}, più alte nelle aree metropolitane.` },
    ],
  });
}

// ─── HTML builders ──────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderFaqHtml(items: Array<{ question: string; answer: string }>, lang: string): string {
  const heading = pick(lang, {
    en: 'Frequently Asked Questions',
    nl: 'Veelgestelde Vragen',
    es: 'Preguntas Frecuentes',
    de: 'Häufig gestellte Fragen',
    fr: 'Questions Fréquentes',
    it: 'Domande Frequenti',
  });
  const body = items.map(({ question, answer }) =>
    `<details><summary><strong>${esc(question)}</strong></summary><p>${esc(answer)}</p></details>`
  ).join('');
  return `<section><h2>${esc(heading)}</h2>${body}</section>`;
}

export function renderPopularCitiesHtml(lang: string, excludeSlug?: string): string {
  const heading = pick(lang, {
    en: 'Popular Padel Cities',
    nl: 'Populaire Padelsteden',
    es: 'Ciudades de Pádel Populares',
    de: 'Beliebte Padel-Städte',
    fr: 'Villes Populaires de Padel',
    it: 'Città di Padel Popolari',
  });
  const items = POPULAR_CITIES
    .filter(c => c.slug !== excludeSlug)
    .map(c => `<li><a href="${SITE_URL}/${lang}/trainers/${c.slug}">${esc(c.name)}</a></li>`)
    .join('');
  return `<section><h2>${esc(heading)}</h2><ul>${items}</ul></section>`;
}

export function renderPopularRegionsHtml(lang: string): string {
  const heading = pick(lang, {
    en: 'Padel Trainers by Region',
    nl: 'Padeltrainers per Regio',
    es: 'Entrenadores por Región',
    de: 'Padel-Trainer nach Region',
    fr: 'Coachs par Région',
    it: 'Maestri per Regione',
  });
  const items = POPULAR_REGIONS
    .map(r => `<li><a href="${SITE_URL}/${lang}/trainers/region/${r.slug}">${esc(r.name)}</a></li>`)
    .join('');
  return `<section><h2>${esc(heading)}</h2><ul>${items}</ul></section>`;
}

export function faqPageSchema(items: Array<{ question: string; answer: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map(({ question, answer }) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer },
    })),
  };
}
