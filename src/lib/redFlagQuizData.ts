export type ProfileId =
  | 'sideline-coach'
  | 'vamos-spammer'
  | 'blame-shifter'
  | 'silent-grudge-holder'
  | 'fashion-criminal'
  | 'overgrip-offender'
  | 'padel-influencer'
  | 'people-pleaser'
  | 'chaos-agent';

export interface QuizProfile {
  id: ProfileId;
  nameKey: string;
  taglineKey: string;
  descriptionKey: string;
  redFlagsKey: string; // comma-separated i18n key prefix
  greenFlagKey: string;
  emoji: string;
  color: string; // HSL for tailwind compatibility
}

export interface QuizOption {
  textKey: string;
  profile: ProfileId;
}

export interface QuizQuestion {
  titleKey: string;
  scenarioKey: string;
  options: QuizOption[];
}

export const profiles: QuizProfile[] = [
  {
    id: 'sideline-coach',
    nameKey: 'redFlagQuiz.profiles.sidelineCoach.name',
    taglineKey: 'redFlagQuiz.profiles.sidelineCoach.tagline',
    descriptionKey: 'redFlagQuiz.profiles.sidelineCoach.description',
    redFlagsKey: 'redFlagQuiz.profiles.sidelineCoach.redFlags',
    greenFlagKey: 'redFlagQuiz.profiles.sidelineCoach.greenFlag',
    emoji: '📋',
    color: '217 91% 53%', // blue #2563EB
  },
  {
    id: 'vamos-spammer',
    nameKey: 'redFlagQuiz.profiles.vamosSpammer.name',
    taglineKey: 'redFlagQuiz.profiles.vamosSpammer.tagline',
    descriptionKey: 'redFlagQuiz.profiles.vamosSpammer.description',
    redFlagsKey: 'redFlagQuiz.profiles.vamosSpammer.redFlags',
    greenFlagKey: 'redFlagQuiz.profiles.vamosSpammer.greenFlag',
    emoji: '🔥',
    color: '0 72% 51%', // red #DC2626
  },
  {
    id: 'blame-shifter',
    nameKey: 'redFlagQuiz.profiles.blameShifter.name',
    taglineKey: 'redFlagQuiz.profiles.blameShifter.tagline',
    descriptionKey: 'redFlagQuiz.profiles.blameShifter.description',
    redFlagsKey: 'redFlagQuiz.profiles.blameShifter.redFlags',
    greenFlagKey: 'redFlagQuiz.profiles.blameShifter.greenFlag',
    emoji: '🪞',
    color: '38 92% 50%', // amber #F59E0B
  },
  {
    id: 'silent-grudge-holder',
    nameKey: 'redFlagQuiz.profiles.silentGrudgeHolder.name',
    taglineKey: 'redFlagQuiz.profiles.silentGrudgeHolder.tagline',
    descriptionKey: 'redFlagQuiz.profiles.silentGrudgeHolder.description',
    redFlagsKey: 'redFlagQuiz.profiles.silentGrudgeHolder.redFlags',
    greenFlagKey: 'redFlagQuiz.profiles.silentGrudgeHolder.greenFlag',
    emoji: '😶',
    color: '215 25% 17%', // dark gray #1F2937
  },
  {
    id: 'fashion-criminal',
    nameKey: 'redFlagQuiz.profiles.fashionCriminal.name',
    taglineKey: 'redFlagQuiz.profiles.fashionCriminal.tagline',
    descriptionKey: 'redFlagQuiz.profiles.fashionCriminal.description',
    redFlagsKey: 'redFlagQuiz.profiles.fashionCriminal.redFlags',
    greenFlagKey: 'redFlagQuiz.profiles.fashionCriminal.greenFlag',
    emoji: '🧦',
    color: '258 90% 66%', // purple #8B5CF6
  },
  {
    id: 'overgrip-offender',
    nameKey: 'redFlagQuiz.profiles.overgripOffender.name',
    taglineKey: 'redFlagQuiz.profiles.overgripOffender.tagline',
    descriptionKey: 'redFlagQuiz.profiles.overgripOffender.description',
    redFlagsKey: 'redFlagQuiz.profiles.overgripOffender.redFlags',
    greenFlagKey: 'redFlagQuiz.profiles.overgripOffender.greenFlag',
    emoji: '🤢',
    color: '24 5% 45%', // stone #78716C
  },
  {
    id: 'padel-influencer',
    nameKey: 'redFlagQuiz.profiles.padelInfluencer.name',
    taglineKey: 'redFlagQuiz.profiles.padelInfluencer.tagline',
    descriptionKey: 'redFlagQuiz.profiles.padelInfluencer.description',
    redFlagsKey: 'redFlagQuiz.profiles.padelInfluencer.redFlags',
    greenFlagKey: 'redFlagQuiz.profiles.padelInfluencer.greenFlag',
    emoji: '📸',
    color: '330 81% 60%', // pink #EC4899
  },
  {
    id: 'people-pleaser',
    nameKey: 'redFlagQuiz.profiles.peoplePleaser.name',
    taglineKey: 'redFlagQuiz.profiles.peoplePleaser.tagline',
    descriptionKey: 'redFlagQuiz.profiles.peoplePleaser.description',
    redFlagsKey: 'redFlagQuiz.profiles.peoplePleaser.redFlags',
    greenFlagKey: 'redFlagQuiz.profiles.peoplePleaser.greenFlag',
    emoji: '🥺',
    color: '160 84% 39%', // green #10B981
  },
  {
    id: 'chaos-agent',
    nameKey: 'redFlagQuiz.profiles.chaosAgent.name',
    taglineKey: 'redFlagQuiz.profiles.chaosAgent.tagline',
    descriptionKey: 'redFlagQuiz.profiles.chaosAgent.description',
    redFlagsKey: 'redFlagQuiz.profiles.chaosAgent.redFlags',
    greenFlagKey: 'redFlagQuiz.profiles.chaosAgent.greenFlag',
    emoji: '🎪',
    color: '18 100% 60%', // orange #FF6B35
  },
];

export const questions: QuizQuestion[] = [
  {
    titleKey: 'redFlagQuiz.q1.title',
    scenarioKey: 'redFlagQuiz.q1.scenario',
    options: [
      { textKey: 'redFlagQuiz.q1.a', profile: 'silent-grudge-holder' },
      { textKey: 'redFlagQuiz.q1.b', profile: 'sideline-coach' },
      { textKey: 'redFlagQuiz.q1.c', profile: 'blame-shifter' },
      { textKey: 'redFlagQuiz.q1.d', profile: 'vamos-spammer' },
    ],
  },
  {
    titleKey: 'redFlagQuiz.q2.title',
    scenarioKey: 'redFlagQuiz.q2.scenario',
    options: [
      { textKey: 'redFlagQuiz.q2.a', profile: 'padel-influencer' },
      { textKey: 'redFlagQuiz.q2.b', profile: 'fashion-criminal' },
      { textKey: 'redFlagQuiz.q2.c', profile: 'overgrip-offender' },
      { textKey: 'redFlagQuiz.q2.d', profile: 'blame-shifter' },
    ],
  },
  {
    titleKey: 'redFlagQuiz.q3.title',
    scenarioKey: 'redFlagQuiz.q3.scenario',
    options: [
      { textKey: 'redFlagQuiz.q3.a', profile: 'silent-grudge-holder' },
      { textKey: 'redFlagQuiz.q3.b', profile: 'sideline-coach' },
      { textKey: 'redFlagQuiz.q3.c', profile: 'people-pleaser' },
      { textKey: 'redFlagQuiz.q3.d', profile: 'blame-shifter' },
    ],
  },
  {
    titleKey: 'redFlagQuiz.q4.title',
    scenarioKey: 'redFlagQuiz.q4.scenario',
    options: [
      { textKey: 'redFlagQuiz.q4.a', profile: 'blame-shifter' },
      { textKey: 'redFlagQuiz.q4.b', profile: 'fashion-criminal' },
      { textKey: 'redFlagQuiz.q4.c', profile: 'chaos-agent' },
      { textKey: 'redFlagQuiz.q4.d', profile: 'chaos-agent' },
    ],
  },
  {
    titleKey: 'redFlagQuiz.q5.title',
    scenarioKey: 'redFlagQuiz.q5.scenario',
    options: [
      { textKey: 'redFlagQuiz.q5.a', profile: 'vamos-spammer' },
      { textKey: 'redFlagQuiz.q5.b', profile: 'blame-shifter' },
      { textKey: 'redFlagQuiz.q5.c', profile: 'sideline-coach' },
      { textKey: 'redFlagQuiz.q5.d', profile: 'padel-influencer' },
    ],
  },
  {
    titleKey: 'redFlagQuiz.q6.title',
    scenarioKey: 'redFlagQuiz.q6.scenario',
    options: [
      { textKey: 'redFlagQuiz.q6.a', profile: 'blame-shifter' },
      { textKey: 'redFlagQuiz.q6.b', profile: 'people-pleaser' },
      { textKey: 'redFlagQuiz.q6.c', profile: 'sideline-coach' },
      { textKey: 'redFlagQuiz.q6.d', profile: 'silent-grudge-holder' },
    ],
  },
  {
    titleKey: 'redFlagQuiz.q7.title',
    scenarioKey: 'redFlagQuiz.q7.scenario',
    options: [
      { textKey: 'redFlagQuiz.q7.a', profile: 'sideline-coach' },
      { textKey: 'redFlagQuiz.q7.b', profile: 'silent-grudge-holder' },
      { textKey: 'redFlagQuiz.q7.c', profile: 'padel-influencer' },
      { textKey: 'redFlagQuiz.q7.d', profile: 'blame-shifter' },
    ],
  },
  {
    titleKey: 'redFlagQuiz.q8.title',
    scenarioKey: 'redFlagQuiz.q8.scenario',
    options: [
      { textKey: 'redFlagQuiz.q8.a', profile: 'fashion-criminal' },
      { textKey: 'redFlagQuiz.q8.b', profile: 'overgrip-offender' },
      { textKey: 'redFlagQuiz.q8.c', profile: 'people-pleaser' },
      { textKey: 'redFlagQuiz.q8.d', profile: 'blame-shifter' },
    ],
  },
  {
    titleKey: 'redFlagQuiz.q9.title',
    scenarioKey: 'redFlagQuiz.q9.scenario',
    options: [
      { textKey: 'redFlagQuiz.q9.a', profile: 'sideline-coach' },
      { textKey: 'redFlagQuiz.q9.b', profile: 'silent-grudge-holder' },
      { textKey: 'redFlagQuiz.q9.c', profile: 'blame-shifter' },
      { textKey: 'redFlagQuiz.q9.d', profile: 'padel-influencer' },
    ],
  },
  {
    titleKey: 'redFlagQuiz.q10.title',
    scenarioKey: 'redFlagQuiz.q10.scenario',
    options: [
      { textKey: 'redFlagQuiz.q10.a', profile: 'blame-shifter' },
      { textKey: 'redFlagQuiz.q10.b', profile: 'chaos-agent' },
      { textKey: 'redFlagQuiz.q10.c', profile: 'padel-influencer' },
      { textKey: 'redFlagQuiz.q10.d', profile: 'people-pleaser' },
    ],
  },
];

export function calculateResult(scores: Record<ProfileId, number>): QuizProfile {
  // Chaos Agent is rare — if 3+ points, show it
  if ((scores['chaos-agent'] || 0) >= 3) {
    return profiles.find(p => p.id === 'chaos-agent')!;
  }

  // Otherwise highest score wins
  let maxScore = 0;
  let winner: ProfileId = 'sideline-coach';
  for (const [id, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      winner = id as ProfileId;
    }
  }
  return profiles.find(p => p.id === winner)!;
}
