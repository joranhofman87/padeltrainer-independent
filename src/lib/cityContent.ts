import type { Location } from '@/lib/locations';

interface CityData {
  cityName: string;
  clubCount: number;
  trainerCount: number;
  indoorCount: number;
  outdoorCount: number;
  topClubs: string[];
  totalIndoorCourts: number;
  totalOutdoorCourts: number;
}

function extractCityData(cityName: string, locations: Location[], trainerCounts: Record<string, number>): CityData {
  const indoorCount = locations.filter(l => (l.indoor_courts ?? 0) > 0).length;
  const outdoorCount = locations.filter(l => (l.outdoor_courts ?? 0) > 0).length;
  const totalTrainers = locations.reduce((sum, l) => sum + (trainerCounts[l.id] || 0), 0);
  const totalIndoorCourts = locations.reduce((sum, l) => sum + (l.indoor_courts ?? 0), 0);
  const totalOutdoorCourts = locations.reduce((sum, l) => sum + (l.outdoor_courts ?? 0), 0);

  const topClubs = [...locations]
    .sort((a, b) => (trainerCounts[b.id] || 0) - (trainerCounts[a.id] || 0))
    .slice(0, 3)
    .map(l => l.name);

  return {
    cityName,
    clubCount: locations.length,
    trainerCount: totalTrainers,
    indoorCount,
    outdoorCount,
    topClubs,
    totalIndoorCourts,
    totalOutdoorCourts,
  };
}

const introTemplates: Record<string, (d: CityData) => string> = {
  nl: (d) => {
    const parts: string[] = [];
    parts.push(`${d.cityName} is een van de snelst groeiende padelsteden van Nederland.`);
    if (d.clubCount > 0) {
      parts.push(`Met ${d.clubCount} ${d.clubCount === 1 ? 'club' : 'clubs'} verspreid over de stad en omgeving vind je altijd een padelbaan in de buurt.`);
    }
    if (d.indoorCount > 0 && d.outdoorCount > 0) {
      parts.push(`De meeste clubs bieden zowel indoor als outdoor banen, zodat je het hele jaar door kunt spelen.`);
    } else if (d.indoorCount > 0) {
      parts.push(`Er zijn indoor banen beschikbaar, zodat je ook in de winter kunt spelen.`);
    }
    if (d.topClubs.length > 0) {
      parts.push(`Populaire clubs zijn onder andere ${d.topClubs.join(', ')}.`);
    }
    if (d.trainerCount > 0) {
      parts.push(`Er ${d.trainerCount === 1 ? 'is' : 'zijn'} ${d.trainerCount} ${d.trainerCount === 1 ? 'trainer' : 'trainers'} actief in ${d.cityName} voor zowel priveles als groepstraining.`);
    }
    // Second paragraph content
    if (d.totalIndoorCourts > 0 || d.totalOutdoorCourts > 0) {
      parts.push(`In totaal beschikt ${d.cityName} over ${d.totalIndoorCourts > 0 ? `${d.totalIndoorCourts} indoor` : ''}${d.totalIndoorCourts > 0 && d.totalOutdoorCourts > 0 ? ' en ' : ''}${d.totalOutdoorCourts > 0 ? `${d.totalOutdoorCourts} outdoor` : ''} ${d.totalIndoorCourts + d.totalOutdoorCourts === 1 ? 'baan' : 'banen'}.`);
    }
    parts.push(`De padelscene in ${d.cityName} groeit snel, met steeds meer spelers die de sport ontdekken. Of je nu een beginnende speler bent die de basisregels wil leren, of een ervaren speler die zijn techniek wil verbeteren, in ${d.cityName} vind je de juiste coach. Vergelijk padelbanen, bekijk beschikbare trainers en boek direct een les.`);
    return parts.join(' ');
  },
  en: (d) => {
    const parts: string[] = [];
    parts.push(`${d.cityName} has become one of the fastest-growing padel cities.`);
    if (d.clubCount > 0) {
      parts.push(`With ${d.clubCount} ${d.clubCount === 1 ? 'club' : 'clubs'} spread across the city and surrounding areas, you'll always find a padel court nearby.`);
    }
    if (d.indoorCount > 0 && d.outdoorCount > 0) {
      parts.push(`Most clubs offer both indoor and outdoor courts, so you can play year-round.`);
    } else if (d.indoorCount > 0) {
      parts.push(`Indoor courts are available, so you can play even during winter.`);
    }
    if (d.topClubs.length > 0) {
      parts.push(`Popular clubs include ${d.topClubs.join(', ')}.`);
    }
    if (d.trainerCount > 0) {
      parts.push(`There ${d.trainerCount === 1 ? 'is' : 'are'} ${d.trainerCount} ${d.trainerCount === 1 ? 'trainer' : 'trainers'} active in ${d.cityName} offering both private and group lessons.`);
    }
    if (d.totalIndoorCourts > 0 || d.totalOutdoorCourts > 0) {
      parts.push(`In total, ${d.cityName} has ${d.totalIndoorCourts > 0 ? `${d.totalIndoorCourts} indoor` : ''}${d.totalIndoorCourts > 0 && d.totalOutdoorCourts > 0 ? ' and ' : ''}${d.totalOutdoorCourts > 0 ? `${d.totalOutdoorCourts} outdoor` : ''} ${d.totalIndoorCourts + d.totalOutdoorCourts === 1 ? 'court' : 'courts'}.`);
    }
    parts.push(`The padel scene in ${d.cityName} is growing rapidly, with more players discovering the sport every month. Whether you're a beginner learning the basics or an experienced player looking to refine your technique, ${d.cityName} has the right coach for you. Compare courts, browse available trainers, and book a lesson today.`);
    return parts.join(' ');
  },
  de: (d) => {
    const parts: string[] = [];
    parts.push(`${d.cityName} hat sich zu einer der am schnellsten wachsenden Padel-Stadte entwickelt.`);
    if (d.clubCount > 0) {
      parts.push(`Mit ${d.clubCount} ${d.clubCount === 1 ? 'Club' : 'Clubs'} in der Stadt und Umgebung findest du immer einen Padel-Platz in der Nahe.`);
    }
    if (d.trainerCount > 0) {
      parts.push(`${d.trainerCount} ${d.trainerCount === 1 ? 'Trainer ist' : 'Trainer sind'} in ${d.cityName} aktiv und bieten sowohl Privat- als auch Gruppenunterricht an.`);
    }
    if (d.totalIndoorCourts > 0 || d.totalOutdoorCourts > 0) {
      parts.push(`Insgesamt verfugt ${d.cityName} uber ${d.totalIndoorCourts > 0 ? `${d.totalIndoorCourts} Indoor-` : ''}${d.totalIndoorCourts > 0 && d.totalOutdoorCourts > 0 ? ' und ' : ''}${d.totalOutdoorCourts > 0 ? `${d.totalOutdoorCourts} Outdoor-` : ''}${d.totalIndoorCourts + d.totalOutdoorCourts === 1 ? 'Platz' : 'Platze'}.`);
    }
    parts.push(`Die Padel-Szene in ${d.cityName} wachst schnell. Vergleiche Platze, finde Trainer und buche noch heute eine Stunde.`);
    return parts.join(' ');
  },
  es: (d) => {
    const parts: string[] = [];
    parts.push(`${d.cityName} se ha convertido en una de las ciudades con mayor crecimiento en padel.`);
    if (d.clubCount > 0) {
      parts.push(`Con ${d.clubCount} ${d.clubCount === 1 ? 'club' : 'clubes'} repartidos por la ciudad y alrededores, siempre encontraras una pista cerca.`);
    }
    if (d.trainerCount > 0) {
      parts.push(`Hay ${d.trainerCount} ${d.trainerCount === 1 ? 'entrenador activo' : 'entrenadores activos'} en ${d.cityName} que ofrecen clases privadas y grupales.`);
    }
    if (d.totalIndoorCourts > 0 || d.totalOutdoorCourts > 0) {
      parts.push(`En total, ${d.cityName} cuenta con ${d.totalIndoorCourts > 0 ? `${d.totalIndoorCourts} pistas indoor` : ''}${d.totalIndoorCourts > 0 && d.totalOutdoorCourts > 0 ? ' y ' : ''}${d.totalOutdoorCourts > 0 ? `${d.totalOutdoorCourts} pistas outdoor` : ''}.`);
    }
    parts.push(`La escena del padel en ${d.cityName} crece rapidamente. Compara pistas, encuentra entrenadores y reserva una clase hoy.`);
    return parts.join(' ');
  },
  fr: (d) => {
    const parts: string[] = [];
    parts.push(`${d.cityName} est devenue l'une des villes a la croissance la plus rapide pour le padel.`);
    if (d.clubCount > 0) {
      parts.push(`Avec ${d.clubCount} ${d.clubCount === 1 ? 'club' : 'clubs'} repartis dans la ville et ses environs, vous trouverez toujours un terrain pres de chez vous.`);
    }
    if (d.trainerCount > 0) {
      parts.push(`${d.trainerCount} ${d.trainerCount === 1 ? 'entraineur est actif' : 'entraineurs sont actifs'} a ${d.cityName}, proposant des cours prives et collectifs.`);
    }
    if (d.totalIndoorCourts > 0 || d.totalOutdoorCourts > 0) {
      parts.push(`Au total, ${d.cityName} dispose de ${d.totalIndoorCourts > 0 ? `${d.totalIndoorCourts} terrains couverts` : ''}${d.totalIndoorCourts > 0 && d.totalOutdoorCourts > 0 ? ' et ' : ''}${d.totalOutdoorCourts > 0 ? `${d.totalOutdoorCourts} terrains exterieurs` : ''}.`);
    }
    parts.push(`La scene du padel a ${d.cityName} est en pleine expansion. Comparez les terrains, trouvez des entraineurs et reservez un cours aujourd'hui.`);
    return parts.join(' ');
  },
};

const clubIntroTemplates: Record<string, (d: CityData) => string> = {
  nl: (d) => `Elke club in ${d.cityName} heeft z'n eigen karakter. Sommige focussen op competitiespelers, anderen zijn meer geschikt voor beginners of families. Hieronder vind je een overzicht met adres, aantal banen en type (indoor/outdoor) zodat je snel de juiste keuze kunt maken.`,
  en: (d) => `Every club in ${d.cityName} has its own character. Some focus on competitive players, others are better suited for beginners or families. Below you'll find an overview with address, court count, and type (indoor/outdoor) to help you choose quickly.`,
  de: (d) => `Jeder Club in ${d.cityName} hat seinen eigenen Charakter. Einige konzentrieren sich auf Wettkampfspieler, andere eignen sich besser fur Anfanger oder Familien. Unten findest du eine Ubersicht mit Adresse, Platzanzahl und Typ (Indoor/Outdoor).`,
  es: (d) => `Cada club en ${d.cityName} tiene su propio caracter. Algunos se enfocan en jugadores competitivos, otros son mas adecuados para principiantes o familias. A continuacion encontraras un resumen con direccion, numero de pistas y tipo (indoor/outdoor).`,
  fr: (d) => `Chaque club a ${d.cityName} a son propre caractere. Certains se concentrent sur les joueurs competitifs, d'autres conviennent mieux aux debutants ou aux familles. Vous trouverez ci-dessous un apercu avec adresse, nombre de terrains et type (couvert/exterieur).`,
  it: (d) => `Ogni club a ${d.cityName} ha il suo carattere. Alcuni si concentrano sui giocatori agonistici, altri sono più adatti a principianti o famiglie. Qui sotto trovi una panoramica con indirizzo, numero di campi e tipo (indoor/outdoor) per aiutarti a scegliere rapidamente.`,
};

const lessonsTemplates: Record<string, (d: CityData) => string> = {
  nl: (d) => `Padel les nemen in ${d.cityName} is de snelste manier om je spel te verbeteren. Kies uit priveles voor persoonlijke aandacht of groepstraining om samen te leren. Priveles kost gemiddeld 40 tot 80 euro per uur, groepslessen zijn er vanaf 25 euro per persoon. De meeste trainers in ${d.cityName} bieden een proefles aan zodat je vrijblijvend kunt kennismaken. Een typische eerste les begint met de basishouding, grip en eenvoudige slagen, zodat je na een uur al een rally kunt spelen. De meeste trainers spreken Nederlands en Engels. Via PadelTrainer.ai boek je direct online, zonder te hoeven bellen of appen.`,
  en: (d) => `Taking padel lessons in ${d.cityName} is the fastest way to improve your game. Choose between private lessons for personal attention or group training to learn together. Private lessons typically cost 40 to 80 euros per hour, while group lessons start from 25 euros per person. Most trainers in ${d.cityName} offer a trial lesson so you can get started risk-free. A typical first lesson covers basic stance, grip, and simple shots, so you'll be rallying within an hour. Most coaches speak English and the local language. With PadelTrainer.ai you can book directly online, no calling or messaging needed.`,
  de: (d) => `Padel-Unterricht in ${d.cityName} ist der schnellste Weg, dein Spiel zu verbessern. Wahle zwischen Privatunterricht oder Gruppentraining. Privatstunden kosten durchschnittlich 40 bis 80 Euro pro Stunde, Gruppenstunden ab 25 Euro pro Person. Eine typische erste Stunde umfasst Grundstellung, Griffhaltung und einfache Schlage. Uber PadelTrainer.ai buchst du direkt online, ohne anrufen oder Nachrichten schreiben zu mussen.`,
  es: (d) => `Tomar clases de padel en ${d.cityName} es la forma mas rapida de mejorar tu juego. Elige entre clases privadas o entrenamientos grupales. Las clases privadas cuestan entre 40 y 80 euros por hora, las grupales desde 25 euros por persona. Una primera clase tipica cubre la posicion basica, el agarre y los golpes simples. Con PadelTrainer.ai reservas directamente online, sin necesidad de llamar.`,
  fr: (d) => `Prendre des cours de padel a ${d.cityName} est le moyen le plus rapide de progresser. Choisissez entre des cours prives ou des entrainements collectifs. Les cours prives coutent entre 40 et 80 euros de l'heure, les cours collectifs a partir de 25 euros par personne. Un premier cours typique couvre la position de base, la prise et les coups simples. Avec PadelTrainer.ai, vous reservez directement en ligne, sans avoir a appeler.`,
};

export function generateCityIntro(cityName: string, locations: Location[], trainerCounts: Record<string, number>, lang: string): string {
  const data = extractCityData(cityName, locations, trainerCounts);
  const template = introTemplates[lang] || introTemplates.en;
  return template(data);
}

export function generateClubIntro(cityName: string, locations: Location[], trainerCounts: Record<string, number>, lang: string): string {
  const data = extractCityData(cityName, locations, trainerCounts);
  const template = clubIntroTemplates[lang] || clubIntroTemplates.en;
  return template(data);
}

export function generateLessonsText(cityName: string, locations: Location[], trainerCounts: Record<string, number>, lang: string): string {
  const data = extractCityData(cityName, locations, trainerCounts);
  const template = lessonsTemplates[lang] || lessonsTemplates.en;
  return template(data);
}

export function generateFAQs(cityName: string, locations: Location[], trainerCounts: Record<string, number>, lang: string): { question: string; answer: string }[] {
  const data = extractCityData(cityName, locations, trainerCounts);
  const topClubNames = data.topClubs.length > 0 ? data.topClubs.join(', ') : '';

  const faqs: Record<string, { question: string; answer: string }[]> = {
    nl: [
      { question: `Hoeveel padelclubs zijn er in ${cityName}?`, answer: `Er ${data.clubCount === 1 ? 'is' : 'zijn'} momenteel ${data.clubCount} ${data.clubCount === 1 ? 'actieve padelclub' : 'actieve padelclubs'} in en rond ${cityName}. ${data.indoorCount > 0 ? `Hiervan bieden ${data.indoorCount} clubs indoor banen aan.` : ''} ${topClubNames ? `Populaire clubs zijn ${topClubNames}.` : ''}` },
      { question: `Wat kost een padelles in ${cityName}?`, answer: `Een groepsles kost gemiddeld 25 tot 50 euro per uur. Priveles kost 40 tot 80 euro per uur, afhankelijk van de trainer. Op PadelTrainer.ai kun je prijzen van verschillende trainers in ${cityName} eenvoudig vergelijken.` },
      { question: `Kan ik indoor padel spelen in ${cityName}?`, answer: `${data.indoorCount > 0 ? `Ja, ${data.indoorCount} ${data.indoorCount === 1 ? 'club biedt' : 'clubs bieden'} indoor banen aan in ${cityName}. In totaal zijn er ${data.totalIndoorCourts} overdekte banen beschikbaar, zodat je het hele jaar door kunt spelen.` : `Op dit moment zijn er voornamelijk outdoor banen in ${cityName}.`}` },
      { question: `Moet ik mijn eigen racket meenemen?`, answer: `De meeste clubs in ${cityName} verhuren rackets voor 5 tot 10 euro. Perfect als je net begint met padel. ${topClubNames ? `Clubs als ${data.topClubs[0]} bieden racketverhuur aan.` : ''}` },
      { question: `Hoe vind ik de beste padeltrainer in ${cityName}?`, answer: `${data.trainerCount > 0 ? `Er zijn ${data.trainerCount} actieve trainers in ${cityName}.` : ''} Vergelijk trainers op PadelTrainer.ai op basis van ervaring, reviews en beschikbaarheid. Boek direct een proefles om de juiste match te vinden.` },
    ],
    en: [
      { question: `How many padel clubs are there in ${cityName}?`, answer: `There ${data.clubCount === 1 ? 'is' : 'are'} currently ${data.clubCount} active padel ${data.clubCount === 1 ? 'club' : 'clubs'} in and around ${cityName}. ${data.indoorCount > 0 ? `${data.indoorCount} of these offer indoor courts.` : ''} ${topClubNames ? `Popular clubs include ${topClubNames}.` : ''}` },
      { question: `What does a padel lesson cost in ${cityName}?`, answer: `Group lessons typically cost 25 to 50 euros per hour. Private coaching costs 40 to 80 euros per hour, depending on the trainer. On PadelTrainer.ai you can easily compare prices from different trainers in ${cityName}.` },
      { question: `Can I play padel indoors in ${cityName}?`, answer: `${data.indoorCount > 0 ? `Yes, ${data.indoorCount} ${data.indoorCount === 1 ? 'club offers' : 'clubs offer'} indoor courts in ${cityName}. There are ${data.totalIndoorCourts} covered courts in total, so you can play year-round.` : `Currently ${cityName} mainly has outdoor courts.`}` },
      { question: `Do I need to bring my own racket?`, answer: `Most clubs in ${cityName} offer racket rental for 5 to 10 euros. Perfect if you're just getting started with padel. ${topClubNames ? `Clubs like ${data.topClubs[0]} offer rental equipment.` : ''}` },
      { question: `How do I find the best padel coach in ${cityName}?`, answer: `${data.trainerCount > 0 ? `There are ${data.trainerCount} active trainers in ${cityName}.` : ''} Compare trainers on PadelTrainer.ai based on experience, reviews, and availability. Book a trial lesson to find the right match.` },
    ],
    de: [
      { question: `Wie viele Padel-Clubs gibt es in ${cityName}?`, answer: `Derzeit gibt es ${data.clubCount} aktive Padel-${data.clubCount === 1 ? 'Club' : 'Clubs'} in und um ${cityName}. ${data.indoorCount > 0 ? `${data.indoorCount} davon bieten Indoor-Platze an.` : ''} ${topClubNames ? `Beliebte Clubs sind ${topClubNames}.` : ''}` },
      { question: `Was kostet eine Padel-Stunde in ${cityName}?`, answer: `Gruppenstunden kosten durchschnittlich 25 bis 50 Euro. Privatunterricht kostet 40 bis 80 Euro pro Stunde. Auf PadelTrainer.ai kannst du Preise verschiedener Trainer in ${cityName} einfach vergleichen.` },
      { question: `Kann ich in ${cityName} Indoor-Padel spielen?`, answer: `${data.indoorCount > 0 ? `Ja, ${data.indoorCount} ${data.indoorCount === 1 ? 'Club bietet' : 'Clubs bieten'} Indoor-Platze in ${cityName} an. Insgesamt stehen ${data.totalIndoorCourts} uberdachte Platze zur Verfugung.` : `Derzeit gibt es in ${cityName} hauptsachlich Outdoor-Platze.`}` },
      { question: `Muss ich meinen eigenen Schlager mitbringen?`, answer: `Die meisten Clubs in ${cityName} bieten Schlagerverleih fur 5 bis 10 Euro an. Perfekt fur Einsteiger.` },
      { question: `Wie finde ich den besten Padel-Trainer in ${cityName}?`, answer: `${data.trainerCount > 0 ? `Es gibt ${data.trainerCount} aktive Trainer in ${cityName}.` : ''} Vergleiche Trainer auf PadelTrainer.ai nach Erfahrung, Bewertungen und Verfugbarkeit.` },
    ],
    es: [
      { question: `Cuantos clubes de padel hay en ${cityName}?`, answer: `Actualmente hay ${data.clubCount} ${data.clubCount === 1 ? 'club' : 'clubes'} de padel activos en ${cityName} y alrededores. ${data.indoorCount > 0 ? `${data.indoorCount} de ellos ofrecen pistas cubiertas.` : ''} ${topClubNames ? `Clubes populares incluyen ${topClubNames}.` : ''}` },
      { question: `Cuanto cuesta una clase de padel en ${cityName}?`, answer: `Las clases grupales cuestan entre 25 y 50 euros por hora. Las clases privadas entre 40 y 80 euros. En PadelTrainer.ai puedes comparar precios de diferentes entrenadores en ${cityName}.` },
      { question: `Puedo jugar padel indoor en ${cityName}?`, answer: `${data.indoorCount > 0 ? `Si, ${data.indoorCount} ${data.indoorCount === 1 ? 'club ofrece' : 'clubes ofrecen'} pistas cubiertas en ${cityName}, con ${data.totalIndoorCourts} pistas en total.` : `Actualmente ${cityName} cuenta principalmente con pistas al aire libre.`}` },
      { question: `Necesito traer mi propia pala?`, answer: `La mayoria de clubes en ${cityName} ofrecen alquiler de palas por 5 a 10 euros. Perfecto si estas empezando.` },
      { question: `Como encuentro el mejor entrenador de padel en ${cityName}?`, answer: `${data.trainerCount > 0 ? `Hay ${data.trainerCount} entrenadores activos en ${cityName}.` : ''} Compara entrenadores en PadelTrainer.ai por experiencia, resenas y disponibilidad.` },
    ],
    fr: [
      { question: `Combien de clubs de padel y a-t-il a ${cityName}?`, answer: `Il y a actuellement ${data.clubCount} ${data.clubCount === 1 ? 'club' : 'clubs'} de padel actifs a ${cityName} et ses environs. ${data.indoorCount > 0 ? `${data.indoorCount} d'entre eux proposent des terrains couverts.` : ''} ${topClubNames ? `Les clubs populaires incluent ${topClubNames}.` : ''}` },
      { question: `Combien coute un cours de padel a ${cityName}?`, answer: `Les cours collectifs coutent entre 25 et 50 euros de l'heure. Les cours prives entre 40 et 80 euros. Sur PadelTrainer.ai vous pouvez facilement comparer les prix des differents entraineurs a ${cityName}.` },
      { question: `Peut-on jouer au padel en interieur a ${cityName}?`, answer: `${data.indoorCount > 0 ? `Oui, ${data.indoorCount} ${data.indoorCount === 1 ? 'club propose' : 'clubs proposent'} des terrains couverts a ${cityName}, soit ${data.totalIndoorCourts} terrains au total.` : `Actuellement, ${cityName} dispose principalement de terrains exterieurs.`}` },
      { question: `Faut-il apporter sa propre raquette?`, answer: `La plupart des clubs de ${cityName} proposent la location de raquettes pour 5 a 10 euros. Ideal pour les debutants.` },
      { question: `Comment trouver le meilleur coach de padel a ${cityName}?`, answer: `${data.trainerCount > 0 ? `Il y a ${data.trainerCount} entraineurs actifs a ${cityName}.` : ''} Comparez les entraineurs sur PadelTrainer.ai par experience, avis et disponibilite.` },
    ],
  };
  return faqs[lang] || faqs.en;
}
