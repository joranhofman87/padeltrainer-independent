// ── Scoring ──────────────────────────────────────────────

export function calculateLevel(totalPoints: number): number {
  if (totalPoints <= 2) return 1.0;
  if (totalPoints <= 4) return 1.5;
  if (totalPoints <= 6) return 2.0;
  if (totalPoints <= 8) return 2.5;
  if (totalPoints <= 11) return 3.0;
  if (totalPoints <= 14) return 3.5;
  if (totalPoints <= 17) return 4.0;
  if (totalPoints <= 20) return 4.5;
  if (totalPoints <= 23) return 5.0;
  if (totalPoints <= 26) return 5.5;
  if (totalPoints <= 28) return 6.0;
  return 6.5;
}

export function getDefaultCountry(lang: string): string {
  switch (lang) {
    case 'es': return 'spain';
    case 'nl': return 'netherlands';
    case 'de': return 'germany';
    case 'fr': return 'france';
    default: return 'other';
  }
}

// ── Countries ────────────────────────────────────────────

export const QUIZ_COUNTRIES = [
  { value: 'spain', label: '🇪🇸 Spain (FEP)' },
  { value: 'netherlands', label: '🇳🇱 Netherlands (KNLTB)' },
  { value: 'belgium', label: '🇧🇪 Belgium (Padel Belgium)' },
  { value: 'france', label: '🇫🇷 France (FFT)' },
  { value: 'sweden', label: '🇸🇪 Sweden (SPF)' },
  { value: 'uk', label: '🇬🇧 United Kingdom (LTA)' },
  { value: 'germany', label: '🇩🇪 Germany (DPV)' },
  { value: 'other', label: '🌍 Other / International' },
] as const;

export type QuizCountry = typeof QUIZ_COUNTRIES[number]['value'];

// ── Rating conversion ────────────────────────────────────

const LEVELS = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5] as const;

export const RATING_MAP: Record<string, Record<number, string>> = {
  spain:       Object.fromEntries(LEVELS.map(l => [l, l.toFixed(1)])),
  netherlands: { 1.0: 'Speelsterkte 9', 1.5: 'Speelsterkte 9', 2.0: 'Speelsterkte 8', 2.5: 'Speelsterkte 8', 3.0: 'Speelsterkte 7', 3.5: 'Speelsterkte 6', 4.0: 'Speelsterkte 5', 4.5: 'Speelsterkte 5', 5.0: 'Speelsterkte 4', 5.5: 'Speelsterkte 3', 6.0: 'Speelsterkte 2', 6.5: 'Speelsterkte 1' },
  belgium:     { 1.0: 'P50', 1.5: 'P50', 2.0: 'P100', 2.5: 'P100', 3.0: 'P200', 3.5: 'P300', 4.0: 'P400', 4.5: 'P500', 5.0: 'P700', 5.5: 'P700', 6.0: 'P1000', 6.5: 'P1000' },
  france:      { 1.0: 'Niveau 1', 1.5: 'Niveau 1', 2.0: 'Niveau 2', 2.5: 'Niveau 2', 3.0: 'Niveau 3', 3.5: 'Niveau 4', 4.0: 'Niveau 5', 4.5: 'Niveau 5', 5.0: 'Niveau 6', 5.5: 'Niveau 7', 6.0: 'Niveau 7', 6.5: 'Niveau 8' },
  sweden:      { 1.0: 'Nivå 1–2', 1.5: 'Nivå 2', 2.0: 'Nivå 3', 2.5: 'Nivå 4', 3.0: 'Nivå 5', 3.5: 'Nivå 6', 4.0: 'Nivå 7', 4.5: 'Nivå 7', 5.0: 'Nivå 8', 5.5: 'Nivå 9', 6.0: 'Nivå 10', 6.5: 'Nivå 10' },
  uk:          { 1.0: 'LTA 1.0', 1.5: 'LTA 1.5', 2.0: 'LTA 2.0', 2.5: 'LTA 2.5', 3.0: 'LTA 3.0', 3.5: 'LTA 3.5', 4.0: 'LTA 4.0', 4.5: 'LTA 4.5', 5.0: 'LTA 5.0', 5.5: 'LTA 5.5', 6.0: 'LTA 6.0', 6.5: 'LTA 6.0' },
  germany:     { 1.0: 'Anfänger', 1.5: 'Anfänger', 2.0: 'Fortgeschrittener Anfänger', 2.5: 'Fortgeschrittener Anfänger', 3.0: 'Mittelstufe', 3.5: 'Mittelstufe', 4.0: 'Fortgeschritten', 4.5: 'Fortgeschritten', 5.0: 'Sehr Fortgeschritten', 5.5: 'Sehr Fortgeschritten', 6.0: 'Experte', 6.5: 'Experte' },
  other:       Object.fromEntries(LEVELS.map(l => [l, l.toFixed(1)])),
};

export function getCountryRating(country: string, level: number): string {
  return RATING_MAP[country]?.[level] ?? level.toFixed(1);
}

export function getCountryLabel(country: string): string {
  return QUIZ_COUNTRIES.find(c => c.value === country)?.label ?? country;
}

// ── Level info ───────────────────────────────────────────

export type LevelTier = 'beginner' | 'intermediate' | 'advanced';

export interface LevelInfo {
  title: string;
  description: string;
  strengths: string[];
  focusAreas: string[];
  racketLevel: LevelTier;
}

export const LEVEL_INFO: Record<number, LevelInfo> = {
  1.0: {
    title: 'Absolute Beginner',
    description: "You're just getting started! The good news: padel is one of the easiest racket sports to pick up. Focus on getting comfortable with the racket and learning the basic rules.",
    strengths: ['Enthusiasm to learn!'],
    focusAreas: ['Basic grip and stance', 'Understanding the court and walls', 'Getting the serve in consistently'],
    racketLevel: 'beginner',
  },
  1.5: {
    title: 'Beginner',
    description: "You've played a few times and know the basics. Your main challenge is consistency — keeping rallies going and getting comfortable with the padel-specific elements like walls and the underhand serve.",
    strengths: ['Basic understanding of the game'],
    focusAreas: ['Forehand and backhand consistency', 'Basic serve technique', 'Understanding when to let the ball hit the glass'],
    racketLevel: 'beginner',
  },
  2.0: {
    title: 'Beginner–Intermediate',
    description: "You can sustain rallies on your forehand side and you're getting more comfortable on court. Your backhand and net game are the next areas to develop.",
    strengths: ['Forehand rally consistency', 'Court awareness developing'],
    focusAreas: ['Backhand development', 'Moving to the net after a good shot', 'Basic volley technique'],
    racketLevel: 'beginner',
  },
  2.5: {
    title: 'Developing Player',
    description: "You're starting to look like a padel player! You can hold rallies on both sides and you're beginning to understand the tactical side of the game.",
    strengths: ['Both forehand and backhand functional', 'Understanding of basic positioning'],
    focusAreas: ['Glass play — reading back-wall bounces', 'Volley placement instead of just blocking', 'Learning the bandeja shot'],
    racketLevel: 'beginner',
  },
  3.0: {
    title: 'Intermediate',
    description: "Solid club player. You can play all the basic shots and you're comfortable at both the net and the back of the court. Focus on tactical awareness and developing advanced shots.",
    strengths: ['Consistent basic shots', 'Good court positioning', 'Comfortable at net and back'],
    focusAreas: ['Developing overhead variety', 'Strategic point construction', 'Reading the opponent'],
    racketLevel: 'intermediate',
  },
  3.5: {
    title: 'Upper Intermediate',
    description: "You're a competent player who can compete in local tournaments. You have a developing tactical game and can execute most shots.",
    strengths: ['Most shots in your repertoire', 'Tactical awareness', 'Good positioning'],
    focusAreas: ['Overhead consistency (bandeja, víbora, smash selection)', 'Defensive lob quality', 'Reducing unforced errors under pressure'],
    racketLevel: 'intermediate',
  },
  4.0: {
    title: 'Advanced Intermediate',
    description: "You're a strong club player who can hold your own in competitive environments. Your technique is solid across all shots and you're starting to construct points strategically.",
    strengths: ['Full shot repertoire', 'Can construct points', 'Reads the game well'],
    focusAreas: ['Advanced tactical patterns', 'Improving your weaker overhead shot', 'Physical conditioning for longer matches'],
    racketLevel: 'intermediate',
  },
  4.5: {
    title: 'Advanced',
    description: "You're a strong competitive player. Your technique is reliable and you can adapt your game plan during a match. You can compete in regional tournaments.",
    strengths: ['Reliable technique across all shots', 'Good match management', 'Effective communication with partner'],
    focusAreas: ['Developing a personal style/strength', 'Advanced spin on overheads', 'Mental game and point pressure management'],
    racketLevel: 'advanced',
  },
  5.0: {
    title: 'Strong Advanced',
    description: "Tournament-level player. You have excellent technique, strong tactical awareness, and the ability to change game plans. You compete at a high level.",
    strengths: ['High consistency under pressure', 'Advanced tactical repertoire', 'Strong net game'],
    focusAreas: ['Fine-tuning shot selection', 'Physical peak performance', 'Professional-level match preparation'],
    racketLevel: 'advanced',
  },
  5.5: {
    title: 'Semi-Professional',
    description: "You play at a level where padel may be part of your profession or you compete at a national level. Your game has very few weaknesses.",
    strengths: ['Near-complete game', 'Exceptional court coverage', 'High-pressure performance'],
    focusAreas: ['Marginal gains in technique', 'Professional physical conditioning', 'Elite mental performance'],
    racketLevel: 'advanced',
  },
  6.0: {
    title: 'Professional',
    description: "You compete at national or international level. Your game is complete with virtually no technical weaknesses. You're among the top players in your country.",
    strengths: ['Complete game', 'Elite-level all aspects', 'Can compete nationally/internationally'],
    focusAreas: ['Peak performance optimization', 'Recovery and longevity', 'Competition strategy'],
    racketLevel: 'advanced',
  },
  6.5: {
    title: 'Elite',
    description: "You're at or near the top of the game. Very few players reach this level — you compete at the highest international circuits.",
    strengths: ['World-class in all aspects'],
    focusAreas: ['Staying at the top'],
    racketLevel: 'advanced',
  },
};

export function getLevelInfo(level: number): LevelInfo {
  return LEVEL_INFO[level] ?? LEVEL_INFO[3.0]!;
}

export function getNextLevel(level: number): number {
  const idx = LEVELS.indexOf(level as typeof LEVELS[number]);
  return idx >= 0 && idx < LEVELS.length - 1 ? LEVELS[idx + 1] : level;
}

// ── Content recommendations ──────────────────────────────

interface ContentLink { title: string; slug: string }

export const CONTENT_LINKS: Record<LevelTier, {
  articles: ContentLink[];
  strokes: ContentLink[];
  blogPosts: ContentLink[];
  racketQuizCta: string;
}> = {
  beginner: {
    articles: [
      { title: 'How to Play Padel for Beginners', slug: 'how-to-play-padel-for-beginners' },
      { title: 'Basic Padel Tactics for Beginners', slug: 'basic-padel-tactics-for-beginners' },
      { title: 'Common Beginner Padel Mistakes', slug: 'common-beginner-padel-mistakes' },
      { title: 'Padel Rules in 5 Minutes', slug: 'padel-rules-in-5-minutes' },
    ],
    strokes: [
      { title: 'Forehand', slug: 'forehand' },
      { title: 'Backhand', slug: 'backhand' },
      { title: 'Serve', slug: 'serve' },
      { title: 'Volley', slug: 'volley' },
    ],
    blogPosts: [
      { title: "How to Play Padel: Complete Beginner's Guide", slug: 'how-to-play-padel-complete-beginners-guide' },
      { title: 'Padel for Tennis Players', slug: 'padel-for-tennis-players-a-transition-guide' },
      { title: 'Best Padel Rackets for Beginners 2026', slug: 'best-padel-rackets-for-beginners-2026' },
    ],
    racketQuizCta: 'Find the perfect beginner racket',
  },
  intermediate: {
    articles: [
      { title: 'How to Improve at Padel', slug: 'how-to-improve-at-padel' },
      { title: 'Advanced Padel Serve Tactics', slug: 'advanced-padel-serve-tactics' },
      { title: 'Wall Play Techniques', slug: 'wall-play-techniques' },
      { title: 'Doubles Positioning and Communication', slug: 'doubles-positioning-and-communication' },
    ],
    strokes: [
      { title: 'Bandeja', slug: 'bandeja' },
      { title: 'Víbora', slug: 'vibora' },
      { title: 'Lob', slug: 'lob' },
      { title: 'Smash', slug: 'smash' },
    ],
    blogPosts: [
      { title: 'Best Padel Rackets 2026', slug: 'best-padel-rackets-2026-expert-guide' },
      { title: 'Mixed Doubles in Padel', slug: 'mixed-doubles-in-padel-tips-and-tactics' },
      { title: 'Common Padel Injuries', slug: 'common-padel-injuries-and-how-to-prevent-them' },
    ],
    racketQuizCta: 'Find a racket that matches your improving game',
  },
  advanced: {
    articles: [
      { title: 'Advanced Padel Serve Tactics', slug: 'advanced-padel-serve-tactics' },
      { title: 'Pressure Point Construction', slug: 'pressure-point-construction' },
      { title: 'Reading the Opponent', slug: 'reading-the-opponent' },
      { title: 'Advanced Wall Combinations', slug: 'advanced-wall-combinations' },
    ],
    strokes: [
      { title: 'Víbora', slug: 'vibora' },
      { title: 'Gancho', slug: 'gancho' },
      { title: 'Rulo', slug: 'rulo' },
      { title: 'Drop Shot', slug: 'drop-shot' },
    ],
    blogPosts: [
      { title: 'Best Padel Rackets 2026', slug: 'best-padel-rackets-2026-expert-guide' },
      { title: 'Padel Fitness: Training for Performance', slug: 'padel-fitness-training-for-performance' },
      { title: 'Tournament Preparation Guide', slug: 'tournament-preparation-guide' },
    ],
    racketQuizCta: 'Find a pro-level racket for your game',
  },
};

// ── Questions ────────────────────────────────────────────

export interface QuizOption {
  text: string;
  points: number;
}

export interface QuizQuestion {
  question: string;
  options: QuizOption[];
}

export const QUIZ_QUESTIONS: Record<string, QuizQuestion[]> = {
  en: [
    {
      question: 'How long have you been playing padel?',
      options: [
        { text: "I haven't started yet or just tried it once", points: 0 },
        { text: 'Less than 6 months', points: 1 },
        { text: '6 months to 2 years', points: 2 },
        { text: 'More than 2 years', points: 3 },
      ],
    },
    {
      question: 'How often do you play?',
      options: [
        { text: 'Rarely / just getting started', points: 0 },
        { text: 'Once or twice a month', points: 1 },
        { text: 'Once or twice a week', points: 2 },
        { text: '3+ times a week', points: 3 },
      ],
    },
    {
      question: 'How comfortable are you with basic shots (forehand, backhand, serve)?',
      options: [
        { text: 'I struggle to hit the ball consistently', points: 0 },
        { text: 'I can rally but miss a lot, especially on the backhand', points: 1 },
        { text: "I'm consistent on most basic shots", points: 2 },
        { text: 'My basics are solid, I rarely make unforced errors on easy balls', points: 3 },
      ],
    },
    {
      question: 'How would you describe your volleys?',
      options: [
        { text: 'I mostly stay at the back of the court', points: 0 },
        { text: 'I go to the net but often miss volleys or hit them into the net', points: 1 },
        { text: "I'm comfortable at the net and can direct most volleys", points: 2 },
        { text: 'I volley with control and placement, and can handle fast balls', points: 3 },
      ],
    },
    {
      question: 'Can you play the wall / glass effectively?',
      options: [
        { text: "The walls confuse me, I don't know when to let the ball bounce off", points: 0 },
        { text: 'I understand the concept but often misjudge timing or position', points: 1 },
        { text: 'I can play most back-wall and side-wall bounces', points: 2 },
        { text: 'I read wall bounces well and use them to create opportunities', points: 3 },
      ],
    },
    {
      question: 'Which overhead shots can you execute?',
      options: [
        { text: "I can't really hit overheads / I just try to block", points: 0 },
        { text: 'I can hit a basic smash but it often goes out or into the net', points: 1 },
        { text: "I can hit smashes and I'm learning the bandeja or víbora", points: 2 },
        { text: 'I regularly use bandeja, víbora, and smash depending on the situation', points: 3 },
      ],
    },
    {
      question: 'How would you describe your tactical awareness?',
      options: [
        { text: 'I just try to get the ball back over the net', points: 0 },
        { text: 'I understand basic positioning (up/back) but forget in the heat of the point', points: 1 },
        { text: 'I play as a pair, communicate, and know when to attack vs defend', points: 2 },
        { text: "I read the game well, anticipate opponents' shots, and construct points strategically", points: 3 },
      ],
    },
    {
      question: 'How do you handle lobs?',
      options: [
        { text: 'I usually let them go or miss the overhead', points: 0 },
        { text: 'I can return some lobs but struggle with deep ones or ones off the glass', points: 1 },
        { text: 'I can handle most lobs, including those bouncing off the back glass', points: 2 },
        { text: "I use lobs offensively and can attack opponents' lobs from any position", points: 3 },
      ],
    },
    {
      question: "What's your serve like?",
      options: [
        { text: 'I just try to get it in', points: 0 },
        { text: 'I have a consistent serve but little variation', points: 1 },
        { text: 'I can vary speed, spin, and placement on my serve', points: 2 },
        { text: 'My serve is a weapon — I use slice, kick, and placement to set up the point', points: 3 },
      ],
    },
    {
      question: 'How do you perform under pressure (match play, tiebreaks)?',
      options: [
        { text: 'I get nervous and make lots of errors', points: 0 },
        { text: 'I can hold it together but play more conservatively', points: 1 },
        { text: 'I stay fairly calm and stick to my game plan', points: 2 },
        { text: 'I thrive under pressure and raise my level in big moments', points: 3 },
      ],
    },
  ],
  es: [
    {
      question: '¿Cuánto tiempo llevas jugando al pádel?',
      options: [
        { text: 'No he empezado todavía o solo lo probé una vez', points: 0 },
        { text: 'Menos de 6 meses', points: 1 },
        { text: 'De 6 meses a 2 años', points: 2 },
        { text: 'Más de 2 años', points: 3 },
      ],
    },
    {
      question: '¿Con qué frecuencia juegas?',
      options: [
        { text: 'Raramente / acabo de empezar', points: 0 },
        { text: 'Una o dos veces al mes', points: 1 },
        { text: 'Una o dos veces por semana', points: 2 },
        { text: '3 o más veces por semana', points: 3 },
      ],
    },
    {
      question: '¿Qué tal te manejas con los golpes básicos?',
      options: [
        { text: 'Me cuesta golpear la bola consistentemente', points: 0 },
        { text: 'Puedo pelotear pero fallo mucho, especialmente de revés', points: 1 },
        { text: 'Soy consistente en la mayoría de golpes básicos', points: 2 },
        { text: 'Mis básicos son sólidos, rara vez cometo errores no forzados', points: 3 },
      ],
    },
    {
      question: '¿Cómo describirías tus voleas?',
      options: [
        { text: 'Casi siempre me quedo en el fondo de la pista', points: 0 },
        { text: 'Voy a la red pero fallo muchas voleas', points: 1 },
        { text: 'Me siento cómodo en la red y puedo dirigir la mayoría de voleas', points: 2 },
        { text: 'Voleo con control y colocación, puedo manejar bolas rápidas', points: 3 },
      ],
    },
    {
      question: '¿Puedes jugar los cristales/paredes eficazmente?',
      options: [
        { text: 'Las paredes me confunden', points: 0 },
        { text: 'Entiendo el concepto pero a menudo calculo mal', points: 1 },
        { text: 'Puedo jugar la mayoría de rebotes de pared y cristal', points: 2 },
        { text: 'Leo bien los rebotes y los uso para crear oportunidades', points: 3 },
      ],
    },
    {
      question: '¿Qué golpes por encima de la cabeza dominas?',
      options: [
        { text: 'No puedo golpear por arriba / solo intento bloquear', points: 0 },
        { text: 'Puedo hacer un remate básico pero a menudo se va fuera', points: 1 },
        { text: 'Puedo rematar y estoy aprendiendo la bandeja o víbora', points: 2 },
        { text: 'Uso bandeja, víbora y remate según la situación', points: 3 },
      ],
    },
    {
      question: '¿Cómo describirías tu conocimiento táctico?',
      options: [
        { text: 'Solo intento devolver la bola', points: 0 },
        { text: 'Entiendo el posicionamiento básico pero lo olvido en el punto', points: 1 },
        { text: 'Juego en pareja, comunico y sé cuándo atacar o defender', points: 2 },
        { text: 'Leo el juego, anticipo y construyo puntos estratégicamente', points: 3 },
      ],
    },
    {
      question: '¿Cómo manejas los globos?',
      options: [
        { text: 'Normalmente los dejo pasar o fallo el remate', points: 0 },
        { text: 'Puedo devolver algunos pero me cuesta con los profundos', points: 1 },
        { text: 'Puedo manejar la mayoría, incluso los del cristal trasero', points: 2 },
        { text: 'Uso los globos ofensivamente y ataco los del rival desde cualquier posición', points: 3 },
      ],
    },
    {
      question: '¿Cómo es tu saque?',
      options: [
        { text: 'Solo intento que entre', points: 0 },
        { text: 'Tengo un saque consistente pero con poca variación', points: 1 },
        { text: 'Puedo variar velocidad, efecto y colocación', points: 2 },
        { text: 'Mi saque es un arma — uso slice, kick y colocación para armar el punto', points: 3 },
      ],
    },
    {
      question: '¿Cómo rindes bajo presión?',
      options: [
        { text: 'Me pongo nervioso y cometo muchos errores', points: 0 },
        { text: 'Aguanto pero juego más conservador', points: 1 },
        { text: 'Me mantengo bastante tranquilo y sigo mi plan de juego', points: 2 },
        { text: 'Rindo mejor bajo presión y subo mi nivel en los momentos clave', points: 3 },
      ],
    },
  ],
  nl: [
    {
      question: 'Hoe lang speel je al padel?',
      options: [
        { text: 'Nog niet begonnen of één keer geprobeerd', points: 0 },
        { text: 'Minder dan 6 maanden', points: 1 },
        { text: '6 maanden tot 2 jaar', points: 2 },
        { text: 'Meer dan 2 jaar', points: 3 },
      ],
    },
    {
      question: 'Hoe vaak speel je?',
      options: [
        { text: 'Zelden / net begonnen', points: 0 },
        { text: 'Een of twee keer per maand', points: 1 },
        { text: 'Een of twee keer per week', points: 2 },
        { text: '3+ keer per week', points: 3 },
      ],
    },
    {
      question: 'Hoe comfortabel ben je met de basisslagen?',
      options: [
        { text: 'Ik heb moeite om de bal consistent te raken', points: 0 },
        { text: 'Ik kan rallyen maar mis veel, vooral op de backhand', points: 1 },
        { text: 'Ik ben consistent op de meeste basisslagen', points: 2 },
        { text: 'Mijn basis is solide, ik maak zelden onnodige fouten', points: 3 },
      ],
    },
    {
      question: 'Hoe zou je je volleys beschrijven?',
      options: [
        { text: 'Ik blijf meestal achterin', points: 0 },
        { text: 'Ik ga naar het net maar mis vaak volleys', points: 1 },
        { text: 'Ik voel me comfortabel aan het net en kan de meeste volleys richting geven', points: 2 },
        { text: 'Ik volley met controle en plaatsing, ook bij snelle ballen', points: 3 },
      ],
    },
    {
      question: 'Kun je het glas/de muren effectief bespelen?',
      options: [
        { text: 'De muren verwarren me', points: 0 },
        { text: 'Ik begrijp het concept maar beoordeel timing vaak verkeerd', points: 1 },
        { text: 'Ik kan de meeste muur- en glasstuiters spelen', points: 2 },
        { text: 'Ik lees muurbounces goed en gebruik ze om kansen te creëren', points: 3 },
      ],
    },
    {
      question: 'Welke bovenhandse slagen beheers je?',
      options: [
        { text: 'Ik kan niet echt bovenhands slaan / ik probeer te blokkeren', points: 0 },
        { text: 'Ik kan een simpele smash maar die gaat vaak uit', points: 1 },
        { text: 'Ik kan smashen en leer de bandeja of víbora', points: 2 },
        { text: 'Ik gebruik bandeja, víbora en smash afhankelijk van de situatie', points: 3 },
      ],
    },
    {
      question: 'Hoe zou je je tactisch bewustzijn beschrijven?',
      options: [
        { text: 'Ik probeer de bal gewoon terug te slaan', points: 0 },
        { text: 'Ik begrijp basispositionering maar vergeet het in de rally', points: 1 },
        { text: 'Ik speel als team, communiceer en weet wanneer ik moet aanvallen of verdedigen', points: 2 },
        { text: 'Ik lees het spel, anticipeer en bouw punten strategisch op', points: 3 },
      ],
    },
    {
      question: 'Hoe ga je om met lobs?',
      options: [
        { text: 'Ik laat ze meestal gaan of mis de overhead', points: 0 },
        { text: 'Ik kan sommige lobs retourneren maar heb moeite met diepe', points: 1 },
        { text: 'Ik kan de meeste lobs aan, ook die van het achterglas', points: 2 },
        { text: 'Ik gebruik lobs offensief en kan lobs van de tegenstander vanuit elke positie aanvallen', points: 3 },
      ],
    },
    {
      question: 'Hoe is je opslag?',
      options: [
        { text: 'Ik probeer hem er gewoon in te krijgen', points: 0 },
        { text: 'Ik heb een consistente opslag maar weinig variatie', points: 1 },
        { text: 'Ik kan variëren in snelheid, spin en plaatsing', points: 2 },
        { text: 'Mijn opslag is een wapen — ik gebruik slice, kick en plaatsing', points: 3 },
      ],
    },
    {
      question: 'Hoe presteer je onder druk?',
      options: [
        { text: 'Ik word nerveus en maak veel fouten', points: 0 },
        { text: 'Ik hou het vol maar speel conservatiever', points: 1 },
        { text: 'Ik blijf vrij kalm en volg mijn gameplan', points: 2 },
        { text: 'Ik gedij onder druk en til mijn niveau in grote momenten', points: 3 },
      ],
    },
  ],
  de: [
    {
      question: 'Wie lange spielst du schon Padel?',
      options: [
        { text: 'Noch nicht angefangen oder nur einmal ausprobiert', points: 0 },
        { text: 'Weniger als 6 Monate', points: 1 },
        { text: '6 Monate bis 2 Jahre', points: 2 },
        { text: 'Mehr als 2 Jahre', points: 3 },
      ],
    },
    {
      question: 'Wie oft spielst du?',
      options: [
        { text: 'Selten / gerade erst angefangen', points: 0 },
        { text: 'Ein- oder zweimal im Monat', points: 1 },
        { text: 'Ein- oder zweimal pro Woche', points: 2 },
        { text: '3+ Mal pro Woche', points: 3 },
      ],
    },
    {
      question: 'Wie sicher bist du bei den Grundschlägen?',
      options: [
        { text: 'Ich habe Schwierigkeiten, den Ball konstant zu treffen', points: 0 },
        { text: 'Ich kann rallyen, aber verfehle viel, besonders mit der Rückhand', points: 1 },
        { text: 'Ich bin bei den meisten Grundschlägen konstant', points: 2 },
        { text: 'Meine Grundlagen sind solide, ich mache selten unerzwungene Fehler', points: 3 },
      ],
    },
    {
      question: 'Wie würdest du deine Volleys beschreiben?',
      options: [
        { text: 'Ich bleibe meistens hinten', points: 0 },
        { text: 'Ich gehe ans Netz, verfehle aber oft Volleys', points: 1 },
        { text: 'Ich fühle mich am Netz wohl und kann die meisten Volleys platzieren', points: 2 },
        { text: 'Ich volleye mit Kontrolle und Platzierung, auch bei schnellen Bällen', points: 3 },
      ],
    },
    {
      question: 'Kannst du die Glaswände effektiv bespielen?',
      options: [
        { text: 'Die Wände verwirren mich', points: 0 },
        { text: 'Ich verstehe das Konzept, aber schätze das Timing oft falsch ein', points: 1 },
        { text: 'Ich kann die meisten Wand- und Glasabpraller spielen', points: 2 },
        { text: 'Ich lese Wandabpraller gut und nutze sie für Chancen', points: 3 },
      ],
    },
    {
      question: 'Welche Überkopfschläge beherrschst du?',
      options: [
        { text: 'Ich kann nicht wirklich über Kopf schlagen / ich versuche nur zu blocken', points: 0 },
        { text: 'Ich kann einen einfachen Smash, aber er geht oft ins Aus', points: 1 },
        { text: 'Ich kann smashen und lerne die Bandeja oder Víbora', points: 2 },
        { text: 'Ich nutze Bandeja, Víbora und Smash je nach Situation', points: 3 },
      ],
    },
    {
      question: 'Wie würdest du dein taktisches Bewusstsein beschreiben?',
      options: [
        { text: 'Ich versuche einfach den Ball zurückzuschlagen', points: 0 },
        { text: 'Ich verstehe die Grundpositionierung, vergesse es aber im Eifer des Punktes', points: 1 },
        { text: 'Ich spiele als Team, kommuniziere und weiß wann angreifen oder verteidigen', points: 2 },
        { text: 'Ich lese das Spiel, antizipiere und konstruiere Punkte strategisch', points: 3 },
      ],
    },
    {
      question: 'Wie gehst du mit Lobs um?',
      options: [
        { text: 'Ich lasse sie meist gehen oder verfehle den Overhead', points: 0 },
        { text: 'Ich kann einige Lobs zurückspielen, habe aber Probleme mit tiefen', points: 1 },
        { text: 'Ich kann die meisten Lobs bewältigen, auch vom Hinterglas', points: 2 },
        { text: 'Ich setze Lobs offensiv ein und kann gegnerische Lobs aus jeder Position angreifen', points: 3 },
      ],
    },
    {
      question: 'Wie ist dein Aufschlag?',
      options: [
        { text: 'Ich versuche ihn einfach reinzubekommen', points: 0 },
        { text: 'Ich habe einen konstanten Aufschlag aber wenig Variation', points: 1 },
        { text: 'Ich kann Geschwindigkeit, Spin und Platzierung variieren', points: 2 },
        { text: 'Mein Aufschlag ist eine Waffe — ich nutze Slice, Kick und Platzierung', points: 3 },
      ],
    },
    {
      question: 'Wie spielst du unter Druck?',
      options: [
        { text: 'Ich werde nervös und mache viele Fehler', points: 0 },
        { text: 'Ich halte durch, spiele aber konservativer', points: 1 },
        { text: 'Ich bleibe ziemlich ruhig und folge meinem Spielplan', points: 2 },
        { text: 'Ich blühe unter Druck auf und steigere mein Level', points: 3 },
      ],
    },
  ],
  fr: [
    {
      question: 'Depuis combien de temps jouez-vous au padel ?',
      options: [
        { text: "Je n'ai pas encore commencé ou j'ai essayé une fois", points: 0 },
        { text: 'Moins de 6 mois', points: 1 },
        { text: 'De 6 mois à 2 ans', points: 2 },
        { text: 'Plus de 2 ans', points: 3 },
      ],
    },
    {
      question: 'À quelle fréquence jouez-vous ?',
      options: [
        { text: 'Rarement / je débute', points: 0 },
        { text: 'Une ou deux fois par mois', points: 1 },
        { text: 'Une ou deux fois par semaine', points: 2 },
        { text: '3+ fois par semaine', points: 3 },
      ],
    },
    {
      question: 'Comment vous sentez-vous avec les coups de base ?',
      options: [
        { text: "J'ai du mal à frapper la balle régulièrement", points: 0 },
        { text: 'Je peux échanger mais je rate beaucoup, surtout en revers', points: 1 },
        { text: 'Je suis régulier sur la plupart des coups de base', points: 2 },
        { text: 'Mes fondamentaux sont solides, je fais rarement des fautes directes', points: 3 },
      ],
    },
    {
      question: 'Comment décririez-vous vos volées ?',
      options: [
        { text: 'Je reste surtout au fond du court', points: 0 },
        { text: 'Je vais au filet mais je rate souvent mes volées', points: 1 },
        { text: "Je suis à l'aise au filet et peux diriger la plupart des volées", points: 2 },
        { text: 'Je volée avec contrôle et placement, même sur les balles rapides', points: 3 },
      ],
    },
    {
      question: 'Savez-vous jouer les vitres/murs efficacement ?',
      options: [
        { text: 'Les murs me déroutent', points: 0 },
        { text: 'Je comprends le concept mais je juge souvent mal le timing', points: 1 },
        { text: 'Je peux jouer la plupart des rebonds de mur et de vitre', points: 2 },
        { text: 'Je lis bien les rebonds et les utilise pour créer des opportunités', points: 3 },
      ],
    },
    {
      question: 'Quels coups au-dessus de la tête maîtrisez-vous ?',
      options: [
        { text: "Je ne peux pas vraiment frapper en hauteur / j'essaie de bloquer", points: 0 },
        { text: 'Je peux faire un smash basique mais il sort souvent', points: 1 },
        { text: "Je peux smasher et j'apprends la bandeja ou la víbora", points: 2 },
        { text: "J'utilise bandeja, víbora et smash selon la situation", points: 3 },
      ],
    },
    {
      question: 'Comment décririez-vous votre sens tactique ?',
      options: [
        { text: "J'essaie juste de renvoyer la balle", points: 0 },
        { text: "Je comprends le positionnement de base mais j'oublie dans le feu du point", points: 1 },
        { text: "Je joue en équipe, communique et sais quand attaquer ou défendre", points: 2 },
        { text: "Je lis le jeu, anticipe et construis les points stratégiquement", points: 3 },
      ],
    },
    {
      question: 'Comment gérez-vous les lobs ?',
      options: [
        { text: 'Je les laisse passer ou je rate le coup', points: 0 },
        { text: 'Je peux retourner certains lobs mais les profonds me posent problème', points: 1 },
        { text: 'Je gère la plupart des lobs, y compris ceux de la vitre arrière', points: 2 },
        { text: "J'utilise les lobs offensivement et peux attaquer ceux de l'adversaire", points: 3 },
      ],
    },
    {
      question: 'Comment est votre service ?',
      options: [
        { text: "J'essaie juste de le mettre dedans", points: 0 },
        { text: "J'ai un service régulier mais peu de variation", points: 1 },
        { text: 'Je peux varier vitesse, effet et placement', points: 2 },
        { text: 'Mon service est une arme — slice, kick et placement pour construire le point', points: 3 },
      ],
    },
    {
      question: 'Comment performez-vous sous pression ?',
      options: [
        { text: 'Je deviens nerveux et fais beaucoup de fautes', points: 0 },
        { text: 'Je tiens le coup mais joue plus prudemment', points: 1 },
        { text: 'Je reste assez calme et suis mon plan de jeu', points: 2 },
        { text: "Je m'épanouis sous pression et élève mon niveau dans les grands moments", points: 3 },
      ],
    },
  ],
};

export function getQuestions(lang: string): QuizQuestion[] {
  return QUIZ_QUESTIONS[lang] ?? QUIZ_QUESTIONS.en!;
}
