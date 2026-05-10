/**
 * Locale-aware FAQ generators for visible (human) UI on city, trainer, club,
 * academy and region pages. Mirrors the FAQs emitted by the bot-rendered
 * `render-page` edge function so both audiences see consistent content.
 *
 * Keep changes here in sync with `supabase/functions/render-page/seo-content.ts`.
 */
export type FaqItem = { question: string; answer: string };
type Lang = 'en' | 'nl' | 'es' | 'de' | 'fr' | 'it';

function pick<T>(lang: string | undefined, map: Record<Lang, T>): T {
  const l = (lang || 'en').slice(0, 2) as Lang;
  return map[l] ?? map.en;
}

export function cityFaqs(city: string, lang?: string): FaqItem[] {
  return pick<FaqItem[]>(lang, {
    en: [
      { question: `How much does a padel lesson in ${city} cost?`, answer: `Padel lessons in ${city} typically range from €40 to €90 per hour, depending on the trainer's experience, certification level, and whether you book a private or group lesson. Most trainers on PadelTrainer.ai display their hourly rate publicly, so you can compare before booking.` },
      { question: `How do I book a padel trainer in ${city}?`, answer: `Browse certified padel trainers in ${city} above, click any trainer profile to see their availability, and book directly through PadelTrainer.ai. You'll see real-time slots, transparent pricing, and verified reviews.` },
      { question: `Are padel trainers in ${city} certified?`, answer: `Many trainers listed in ${city} hold official padel coaching certifications (FIP, MEP, federation diplomas). We display every trainer's credentials, experience and reviews so you can choose with confidence.` },
      { question: `Can beginners take padel lessons in ${city}?`, answer: `Yes. Most ${city} trainers offer beginner-friendly programs covering grip, footwork, basic strokes and game rules. Filter by "Beginners" specialization to find coaches with proven beginner experience.` },
      { question: `Do trainers in ${city} offer group lessons?`, answer: `Group lessons (2-4 players) are widely available in ${city} and typically cost 40-60% less per person than private lessons.` },
      { question: `What's the best time to book a padel lesson in ${city}?`, answer: `Weekday mornings and early afternoons offer the best availability and often discounted rates. Weekends and evenings book up fastest — reserve at least a week in advance for prime slots.` },
    ],
    nl: [
      { question: `Hoeveel kost een padelles in ${city}?`, answer: `Padellessen in ${city} kosten meestal tussen €40 en €90 per uur, afhankelijk van ervaring, certificering en of je een privé- of groepsles boekt. De meeste trainers op PadelTrainer.ai tonen hun uurtarief openbaar zodat je kunt vergelijken voor je boekt.` },
      { question: `Hoe boek ik een padeltrainer in ${city}?`, answer: `Bekijk gecertificeerde padeltrainers in ${city} hierboven, klik op een profiel om beschikbaarheid te zien en boek direct via PadelTrainer.ai. Je ziet realtime tijdsloten, transparante prijzen en geverifieerde reviews.` },
      { question: `Zijn padeltrainers in ${city} gecertificeerd?`, answer: `Veel trainers in ${city} hebben officiële padelcoachdiploma's (FIP, MEP, KNLTB). Per trainer tonen we de kwalificaties, ervaring en reviews zodat je met vertrouwen kunt kiezen.` },
      { question: `Kunnen beginners padelles nemen in ${city}?`, answer: `Ja. De meeste ${city}-trainers bieden beginnersprogramma's met grip, voetenwerk, basisslagen en spelregels. Filter op "Beginners" om coaches te vinden met bewezen ervaring.` },
      { question: `Bieden trainers in ${city} groepslessen aan?`, answer: `Groepslessen (2-4 spelers) zijn breed beschikbaar in ${city} en kosten meestal 40-60% minder per persoon dan privélessen.` },
      { question: `Wat is het beste moment om een padelles te boeken in ${city}?`, answer: `Doordeweekse ochtenden en vroege middagen hebben de beste beschikbaarheid en vaak korting. Avonden en weekends zijn snel volgeboekt — reserveer minstens een week vooruit.` },
    ],
    es: [
      { question: `¿Cuánto cuesta una clase de pádel en ${city}?`, answer: `Las clases de pádel en ${city} suelen costar entre €40 y €90 por hora, según la experiencia del entrenador, su titulación y si reservas clase privada o grupal.` },
      { question: `¿Cómo reservo un entrenador de pádel en ${city}?`, answer: `Explora entrenadores certificados de pádel en ${city}, haz clic en un perfil para ver disponibilidad y reserva directamente. Verás horarios en tiempo real, precios claros y reseñas verificadas.` },
      { question: `¿Los entrenadores en ${city} están certificados?`, answer: `Muchos entrenadores en ${city} cuentan con titulaciones oficiales (FIP, MEP, federaciones).` },
      { question: `¿Pueden los principiantes recibir clases en ${city}?`, answer: `Sí. La mayoría de entrenadores en ${city} ofrecen programas para principiantes.` },
      { question: `¿Ofrecen clases grupales los entrenadores en ${city}?`, answer: `Sí. Las clases grupales (2-4 jugadores) cuestan un 40-60% menos por persona que las privadas.` },
      { question: `¿Cuál es el mejor momento para reservar en ${city}?`, answer: `Las mañanas y primeras horas de la tarde entre semana ofrecen mejor disponibilidad y, a veces, descuentos.` },
    ],
    de: [
      { question: `Was kostet eine Padel-Stunde in ${city}?`, answer: `Padel-Stunden in ${city} kosten in der Regel 40 € bis 90 €/Stunde, abhängig von Erfahrung, Lizenz und Format (Einzel/Gruppe).` },
      { question: `Wie buche ich einen Padel-Trainer in ${city}?`, answer: `Stöbere durch zertifizierte Padel-Trainer in ${city}, öffne ein Profil für Verfügbarkeit und buche direkt über PadelTrainer.ai.` },
      { question: `Sind Padel-Trainer in ${city} zertifiziert?`, answer: `Viele Trainer in ${city} besitzen offizielle Padel-Lizenzen (FIP, MEP, Verbandstrainer).` },
      { question: `Können Anfänger in ${city} Padel-Stunden nehmen?`, answer: `Ja. Die meisten Trainer bieten Anfängerprogramme mit Griff, Beinarbeit, Grundschlägen und Spielregeln.` },
      { question: `Bieten Trainer in ${city} Gruppentraining an?`, answer: `Gruppentraining (2-4 Spieler) ist weit verbreitet und kostet pro Person meist 40-60% weniger als Einzeltraining.` },
      { question: `Wann ist die beste Zeit zu buchen?`, answer: `Werktags vormittags und am frühen Nachmittag gibt es die beste Verfügbarkeit und häufig Rabatte.` },
    ],
    fr: [
      { question: `Combien coûte un cours de padel à ${city} ?`, answer: `Les cours à ${city} coûtent généralement 40 €-90 €/heure, selon l'expérience du coach, sa certification et le format (privé/collectif).` },
      { question: `Comment réserver un coach à ${city} ?`, answer: `Parcourez les coachs certifiés à ${city}, ouvrez un profil pour voir les disponibilités et réservez directement via PadelTrainer.ai.` },
      { question: `Les coachs à ${city} sont-ils certifiés ?`, answer: `De nombreux coachs à ${city} sont titulaires de diplômes officiels (FIP, MEP, fédéraux).` },
      { question: `Les débutants peuvent-ils prendre des cours à ${city} ?`, answer: `Oui. La plupart des coachs proposent des programmes débutants.` },
      { question: `Y a-t-il des cours collectifs à ${city} ?`, answer: `Oui. Les cours collectifs (2-4 joueurs) coûtent 40-60% moins cher par personne que les cours privés.` },
      { question: `Quel est le meilleur moment pour réserver à ${city} ?`, answer: `Les matinées et débuts d'après-midi en semaine offrent la meilleure disponibilité.` },
    ],
    it: [
      { question: `Quanto costa una lezione di padel a ${city}?`, answer: `Le lezioni a ${city} costano in genere 40 €-90 €/ora, in base all'esperienza, alla certificazione del maestro e al formato.` },
      { question: `Come prenoto un maestro a ${city}?`, answer: `Sfoglia i maestri certificati a ${city}, apri un profilo per vedere disponibilità e prezzi e prenota direttamente.` },
      { question: `I maestri a ${city} sono certificati?`, answer: `Molti maestri a ${city} possiedono certificazioni ufficiali (FIP, MEP, federali).` },
      { question: `I principianti possono prendere lezioni a ${city}?`, answer: `Sì. La maggior parte dei maestri a ${city} offre programmi per principianti.` },
      { question: `Ci sono lezioni di gruppo a ${city}?`, answer: `Sì. Le lezioni di gruppo (2-4 giocatori) costano il 40-60% in meno rispetto a quelle individuali.` },
      { question: `Qual è il momento migliore per prenotare a ${city}?`, answer: `Le mattine e i primi pomeriggi infrasettimanali offrono la migliore disponibilità.` },
    ],
  });
}

export function trainerFaqs(name: string, lang?: string): FaqItem[] {
  return pick<FaqItem[]>(lang, {
    en: [
      { question: `How do I book a lesson with ${name}?`, answer: `Open ${name}'s profile, choose an available time slot from the calendar, and complete payment securely through PadelTrainer.ai. You'll receive instant confirmation by email.` },
      { question: `What experience does ${name} have?`, answer: `Each trainer profile shows years of coaching experience, certifications (FIP, MEP, federation), specializations, and verified reviews from past players.` },
      { question: `Can I cancel or reschedule a lesson with ${name}?`, answer: `Yes. Most trainers allow free cancellation up to 24 hours before the lesson. Specific cancellation terms are visible on the booking page before you confirm payment.` },
      { question: `Does ${name} offer group lessons?`, answer: `Check the "Specializations" section of the profile — trainers offering group, private, junior or competition coaching list it explicitly.` },
    ],
    nl: [
      { question: `Hoe boek ik een les bij ${name}?`, answer: `Open het profiel van ${name}, kies een beschikbaar tijdslot uit de kalender en betaal veilig via PadelTrainer.ai. Je krijgt direct een bevestiging per e-mail.` },
      { question: `Welke ervaring heeft ${name}?`, answer: `Op elk trainersprofiel vind je het aantal jaren ervaring, certificeringen (FIP, MEP, KNLTB), specialisaties en geverifieerde reviews.` },
      { question: `Kan ik een les bij ${name} annuleren of verzetten?`, answer: `Ja. De meeste trainers staan gratis annuleren toe tot 24 uur voor de les.` },
      { question: `Geeft ${name} groepslessen?`, answer: `Bekijk de "Specialisaties" op het profiel — trainers die groeps-, privé-, jeugd- of wedstrijdtraining geven, vermelden dit duidelijk.` },
    ],
    es: [
      { question: `¿Cómo reservo una clase con ${name}?`, answer: `Abre el perfil de ${name}, elige un horario disponible y completa el pago de forma segura.` },
      { question: `¿Qué experiencia tiene ${name}?`, answer: `Cada perfil muestra años de experiencia, titulaciones (FIP, MEP), especialidades y reseñas verificadas.` },
      { question: `¿Puedo cancelar o cambiar una clase?`, answer: `Sí. La mayoría de entrenadores permite cancelación gratuita hasta 24 horas antes.` },
      { question: `¿${name} ofrece clases grupales?`, answer: `Mira la sección "Especialidades" — los entrenadores indican claramente si ofrecen grupales, privadas o competición.` },
    ],
    de: [
      { question: `Wie buche ich eine Stunde bei ${name}?`, answer: `Öffne das Profil von ${name}, wähle einen freien Termin und zahle sicher über PadelTrainer.ai.` },
      { question: `Welche Erfahrung hat ${name}?`, answer: `Jedes Trainerprofil zeigt Erfahrung, Lizenzen (FIP, MEP), Spezialisierungen und Bewertungen.` },
      { question: `Kann ich stornieren oder verschieben?`, answer: `Ja. Die meisten Trainer erlauben kostenlose Stornierung bis 24 Stunden vorher.` },
      { question: `Bietet ${name} Gruppentraining?`, answer: `Sieh dir den Abschnitt "Spezialisierungen" an.` },
    ],
    fr: [
      { question: `Comment réserver un cours avec ${name} ?`, answer: `Ouvrez le profil de ${name}, choisissez un créneau disponible et finalisez le paiement.` },
      { question: `Quelle est l'expérience de ${name} ?`, answer: `Chaque profil affiche les années d'expérience, les diplômes et les avis vérifiés.` },
      { question: `Puis-je annuler ou reporter ?`, answer: `Oui. La plupart des coachs autorisent l'annulation gratuite jusqu'à 24h avant.` },
      { question: `${name} propose-t-il des cours collectifs ?`, answer: `Consultez la section "Spécialisations" du profil.` },
    ],
    it: [
      { question: `Come prenoto una lezione con ${name}?`, answer: `Apri il profilo di ${name}, scegli un orario disponibile e completa il pagamento.` },
      { question: `Che esperienza ha ${name}?`, answer: `Ogni profilo mostra esperienza, certificazioni e recensioni verificate.` },
      { question: `Posso annullare o spostare una lezione?`, answer: `Sì. La maggior parte dei maestri consente cancellazioni gratuite fino a 24 ore prima.` },
      { question: `${name} offre lezioni di gruppo?`, answer: `Controlla la sezione "Specializzazioni".` },
    ],
  });
}

export function clubFaqs(name: string, lang?: string): FaqItem[] {
  return pick<FaqItem[]>(lang, {
    en: [
      { question: `How do I book a court at ${name}?`, answer: `${name} is listed on PadelTrainer.ai with all available trainers, courts and amenities. Pick a coach and book through their profile to play here.` },
      { question: `Does ${name} have indoor and outdoor padel courts?`, answer: `Court counts (indoor + outdoor) and amenities are listed in the club profile above.` },
      { question: `Can beginners play at ${name}?`, answer: `Yes — most clubs welcome players of all levels and many resident trainers run beginner programs.` },
      { question: `Are padel lessons available at ${name}?`, answer: `Yes. Browse the trainers listed at this club above and book lessons directly with your preferred coach.` },
    ],
    nl: [
      { question: `Hoe boek ik een baan bij ${name}?`, answer: `${name} staat vermeld op PadelTrainer.ai met alle beschikbare trainers, banen en voorzieningen.` },
      { question: `Heeft ${name} indoor en outdoor padelbanen?`, answer: `Het aantal banen en voorzieningen staat hierboven in het clubprofiel.` },
      { question: `Kunnen beginners spelen bij ${name}?`, answer: `Ja, de meeste clubs verwelkomen spelers van alle niveaus.` },
      { question: `Zijn er padellessen beschikbaar bij ${name}?`, answer: `Ja. Bekijk de trainers die bij deze club werken en boek direct.` },
    ],
    es: [
      { question: `¿Cómo reservo una pista en ${name}?`, answer: `${name} está listado en PadelTrainer.ai con todos los entrenadores y servicios disponibles.` },
      { question: `¿${name} tiene pistas indoor y outdoor?`, answer: `El número de pistas y servicios aparece en el perfil del club.` },
      { question: `¿Pueden jugar los principiantes?`, answer: `Sí, la mayoría de clubes da la bienvenida a jugadores de todos los niveles.` },
      { question: `¿Hay clases de pádel en ${name}?`, answer: `Sí. Mira los entrenadores listados y reserva directamente.` },
    ],
    de: [
      { question: `Wie buche ich einen Court bei ${name}?`, answer: `${name} ist auf PadelTrainer.ai gelistet inkl. aller Trainer und Ausstattung.` },
      { question: `Hat ${name} Indoor- und Outdoor-Courts?`, answer: `Anzahl der Courts und Ausstattung findest du im Clubprofil.` },
      { question: `Können Anfänger bei ${name} spielen?`, answer: `Ja, die meisten Clubs heißen alle Spielstärken willkommen.` },
      { question: `Gibt es bei ${name} Padel-Unterricht?`, answer: `Ja. Sieh dir die Trainer dieses Clubs an und buche direkt.` },
    ],
    fr: [
      { question: `Comment réserver un terrain à ${name} ?`, answer: `${name} est référencé sur PadelTrainer.ai avec tous les coachs disponibles.` },
      { question: `${name} a-t-il des terrains indoor et outdoor ?`, answer: `Le nombre de terrains et les services figurent dans le profil du club.` },
      { question: `Les débutants peuvent-ils jouer à ${name} ?`, answer: `Oui, la plupart des clubs accueillent tous les niveaux.` },
      { question: `Y a-t-il des cours de padel à ${name} ?`, answer: `Oui. Consultez les coachs de ce club et réservez directement.` },
    ],
    it: [
      { question: `Come prenoto un campo a ${name}?`, answer: `${name} è presente su PadelTrainer.ai con tutti i maestri disponibili.` },
      { question: `${name} ha campi indoor e outdoor?`, answer: `Numero di campi e servizi sono indicati nel profilo del club.` },
      { question: `I principianti possono giocare a ${name}?`, answer: `Sì, la maggior parte dei club accoglie giocatori di tutti i livelli.` },
      { question: `Ci sono lezioni a ${name}?`, answer: `Sì. Sfoglia i maestri presenti e prenota direttamente.` },
    ],
  });
}

export function academyFaqs(name: string, lang?: string): FaqItem[] {
  return pick<FaqItem[]>(lang, {
    en: [
      { question: `What programs does ${name} offer?`, answer: `${name} runs structured padel programs ranging from beginner clinics to competitive squad training. Browse the open cycles and trainers above to view current offerings.` },
      { question: `How do I register for a course at ${name}?`, answer: `Pick an open cycle from the schedule above and follow the registration steps. You'll be matched with a slot that fits your level and availability.` },
      { question: `What's the difference between an academy and a single trainer?`, answer: `Academies coordinate multiple coaches, training cycles and player levels — ideal for ongoing structured improvement.` },
      { question: `Are sessions at ${name} suitable for all levels?`, answer: `Yes — most academies offer parallel groups for beginners, intermediate and advanced players.` },
    ],
    nl: [
      { question: `Welke programma's biedt ${name}?`, answer: `${name} organiseert gestructureerde padelprogramma's van beginnersclinics tot competitieve squadtraining.` },
      { question: `Hoe meld ik me aan voor een cursus bij ${name}?`, answer: `Kies een open cyclus uit het schema hierboven en volg de aanmeldstappen.` },
      { question: `Wat is het verschil tussen een academy en een individuele trainer?`, answer: `Academies coördineren meerdere coaches, cycli en spelersniveaus.` },
      { question: `Zijn de sessies bij ${name} geschikt voor alle niveaus?`, answer: `Ja — de meeste academies bieden parallelle groepen voor beginners, gemiddeld en gevorderd.` },
    ],
    es: [
      { question: `¿Qué programas ofrece ${name}?`, answer: `${name} organiza programas estructurados desde clinics para principiantes hasta entrenamiento competitivo.` },
      { question: `¿Cómo me inscribo en un curso?`, answer: `Elige un ciclo abierto en el calendario y sigue los pasos.` },
      { question: `¿Diferencia entre academia y entrenador individual?`, answer: `Las academias coordinan varios coaches, ciclos y niveles.` },
      { question: `¿Las sesiones son aptas para todos los niveles?`, answer: `Sí — la mayoría de academias ofrece grupos paralelos.` },
    ],
    de: [
      { question: `Welche Programme bietet ${name}?`, answer: `${name} organisiert strukturierte Padel-Programme von Anfänger-Clinics bis Wettkampftraining.` },
      { question: `Wie melde ich mich für einen Kurs an?`, answer: `Wähle einen offenen Zyklus aus dem Plan und folge den Anmeldeschritten.` },
      { question: `Unterschied Akademie vs. Einzeltrainer?`, answer: `Akademien koordinieren mehrere Coaches, Zyklen und Spielniveaus.` },
      { question: `Sind die Einheiten für alle Niveaus geeignet?`, answer: `Ja — parallele Gruppen für Anfänger, Mittelstufe und Fortgeschrittene.` },
    ],
    fr: [
      { question: `Quels programmes propose ${name} ?`, answer: `${name} propose des programmes du clinic débutant au cycle compétition.` },
      { question: `Comment s'inscrire à un cours ?`, answer: `Choisissez un cycle ouvert dans le planning et suivez les étapes.` },
      { question: `Différence académie vs coach individuel ?`, answer: `Les académies coordonnent plusieurs coachs, cycles et niveaux.` },
      { question: `Les séances conviennent-elles à tous les niveaux ?`, answer: `Oui — groupes parallèles débutant, intermédiaire et avancé.` },
    ],
    it: [
      { question: `Quali programmi offre ${name}?`, answer: `${name} organizza programmi dal clinic per principianti al training agonistico.` },
      { question: `Come mi iscrivo a un corso?`, answer: `Scegli un ciclo aperto e segui i passaggi.` },
      { question: `Differenza accademia vs maestro singolo?`, answer: `Le accademie coordinano più coach, cicli e livelli.` },
      { question: `Le sessioni sono per tutti i livelli?`, answer: `Sì — gruppi paralleli per principianti, intermedi e avanzati.` },
    ],
  });
}
