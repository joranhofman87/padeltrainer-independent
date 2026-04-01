import type { Location } from '@/lib/locations';

interface CityData {
  cityName: string;
  clubCount: number;
  trainerCount: number;
  indoorCount: number;
  outdoorCount: number;
  topClubs: string[];
}

function extractCityData(cityName: string, locations: Location[], trainerCounts: Record<string, number>): CityData {
  const indoorCount = locations.filter(l => (l.indoor_courts ?? 0) > 0).length;
  const outdoorCount = locations.filter(l => (l.outdoor_courts ?? 0) > 0).length;
  const totalTrainers = locations.reduce((sum, l) => sum + (trainerCounts[l.id] || 0), 0);

  // Top clubs by trainer count
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
    parts.push(`Of je nu een beginnende speler bent die de basisregels wil leren, of een ervaren speler die zijn techniek wil verbeteren, in ${d.cityName} vind je de juiste coach. Vergelijk padelbanen, bekijk beschikbare trainers en boek direct een les.`);
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
    parts.push(`Whether you're a beginner learning the basics or an experienced player looking to refine your technique, ${d.cityName} has the right coach for you. Compare courts, browse available trainers, and book a lesson today.`);
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
    parts.push(`Vergleiche Platze, finde Trainer und buche noch heute eine Stunde.`);
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
    parts.push(`Compara pistas, encuentra entrenadores y reserva una clase hoy.`);
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
    parts.push(`Comparez les terrains, trouvez des entraineurs et reservez un cours aujourd'hui.`);
    return parts.join(' ');
  },
};

const lessonsTemplates: Record<string, (d: CityData) => string> = {
  nl: (d) => `Padel les nemen in ${d.cityName} is de snelste manier om je spel te verbeteren. Kies uit priveles voor persoonlijke aandacht of groepstraining om samen te leren. Priveles kost gemiddeld 40 tot 80 euro per uur, groepslessen zijn er vanaf 25 euro per persoon. De meeste trainers in ${d.cityName} bieden een proefles aan zodat je vrijblijvend kunt kennismaken.`,
  en: (d) => `Taking padel lessons in ${d.cityName} is the fastest way to improve your game. Choose between private lessons for personal attention or group training to learn together. Private lessons typically cost 40 to 80 euros per hour, while group lessons start from 25 euros per person. Most trainers in ${d.cityName} offer a trial lesson so you can get started risk-free.`,
  de: (d) => `Padel-Unterricht in ${d.cityName} ist der schnellste Weg, dein Spiel zu verbessern. Wahle zwischen Privatunterricht oder Gruppentraining. Privatstunden kosten durchschnittlich 40 bis 80 Euro pro Stunde, Gruppenstunden ab 25 Euro pro Person.`,
  es: (d) => `Tomar clases de padel en ${d.cityName} es la forma mas rapida de mejorar tu juego. Elige entre clases privadas o entrenamientos grupales. Las clases privadas cuestan entre 40 y 80 euros por hora, las grupales desde 25 euros por persona.`,
  fr: (d) => `Prendre des cours de padel a ${d.cityName} est le moyen le plus rapide de progresser. Choisissez entre des cours prives ou des entrainements collectifs. Les cours prives coutent entre 40 et 80 euros de l'heure, les cours collectifs a partir de 25 euros par personne.`,
};

export function generateCityIntro(cityName: string, locations: Location[], trainerCounts: Record<string, number>, lang: string): string {
  const data = extractCityData(cityName, locations, trainerCounts);
  const template = introTemplates[lang] || introTemplates.en;
  return template(data);
}

export function generateLessonsText(cityName: string, locations: Location[], trainerCounts: Record<string, number>, lang: string): string {
  const data = extractCityData(cityName, locations, trainerCounts);
  const template = lessonsTemplates[lang] || lessonsTemplates.en;
  return template(data);
}

export function generateFAQs(cityName: string, clubCount: number, lang: string): { question: string; answer: string }[] {
  const faqs: Record<string, { question: string; answer: string }[]> = {
    nl: [
      { question: `Hoeveel padelclubs zijn er in ${cityName}?`, answer: `Er ${clubCount === 1 ? 'is' : 'zijn'} momenteel ${clubCount} ${clubCount === 1 ? 'actieve padelclub' : 'actieve padelclubs'} in en rond ${cityName}.` },
      { question: `Wat kost een padelles in ${cityName}?`, answer: `Een groepsles kost gemiddeld 25 tot 50 euro per uur. Priveles kost 40 tot 80 euro per uur, afhankelijk van de trainer.` },
      { question: `Kan ik indoor padel spelen in ${cityName}?`, answer: `Ja, de meeste clubs in ${cityName} bieden indoor banen aan zodat je het hele jaar door kunt spelen.` },
      { question: `Moet ik mijn eigen racket meenemen?`, answer: `De meeste clubs in ${cityName} verhuren rackets voor 5 tot 10 euro. Perfect als je net begint met padel.` },
      { question: `Hoe vind ik de beste padeltrainer in ${cityName}?`, answer: `Vergelijk trainers op PadelTrainer.ai op basis van ervaring, reviews en beschikbaarheid. Boek direct een proefles.` },
    ],
    en: [
      { question: `How many padel clubs are there in ${cityName}?`, answer: `There ${clubCount === 1 ? 'is' : 'are'} currently ${clubCount} active padel ${clubCount === 1 ? 'club' : 'clubs'} in and around ${cityName}.` },
      { question: `What does a padel lesson cost in ${cityName}?`, answer: `Group lessons typically cost 25 to 50 euros per hour. Private coaching costs 40 to 80 euros per hour, depending on the trainer.` },
      { question: `Can I play padel indoors in ${cityName}?`, answer: `Yes, most clubs in ${cityName} offer indoor courts so you can play year-round.` },
      { question: `Do I need to bring my own racket?`, answer: `Most clubs in ${cityName} offer racket rental for 5 to 10 euros. Perfect if you're just getting started with padel.` },
      { question: `How do I find the best padel coach in ${cityName}?`, answer: `Compare trainers on PadelTrainer.ai based on experience, reviews, and availability. Book a trial lesson directly.` },
    ],
    de: [
      { question: `Wie viele Padel-Clubs gibt es in ${cityName}?`, answer: `Derzeit gibt es ${clubCount} aktive Padel-${clubCount === 1 ? 'Club' : 'Clubs'} in und um ${cityName}.` },
      { question: `Was kostet eine Padel-Stunde in ${cityName}?`, answer: `Gruppenstunden kosten durchschnittlich 25 bis 50 Euro. Privatunterricht kostet 40 bis 80 Euro pro Stunde.` },
      { question: `Kann ich in ${cityName} Indoor-Padel spielen?`, answer: `Ja, die meisten Clubs bieten Indoor-Platze an, damit du das ganze Jahr uber spielen kannst.` },
      { question: `Muss ich meinen eigenen Schlager mitbringen?`, answer: `Die meisten Clubs in ${cityName} bieten Schlagerverleih fur 5 bis 10 Euro an.` },
      { question: `Wie finde ich den besten Padel-Trainer in ${cityName}?`, answer: `Vergleiche Trainer auf PadelTrainer.ai nach Erfahrung, Bewertungen und Verfugbarkeit.` },
    ],
    es: [
      { question: `Cuantos clubes de padel hay en ${cityName}?`, answer: `Actualmente hay ${clubCount} ${clubCount === 1 ? 'club' : 'clubes'} de padel activos en ${cityName} y alrededores.` },
      { question: `Cuanto cuesta una clase de padel en ${cityName}?`, answer: `Las clases grupales cuestan entre 25 y 50 euros por hora. Las clases privadas entre 40 y 80 euros.` },
      { question: `Puedo jugar padel indoor en ${cityName}?`, answer: `Si, la mayoria de clubes en ${cityName} ofrecen pistas cubiertas para jugar todo el ano.` },
      { question: `Necesito traer mi propia pala?`, answer: `La mayoria de clubes en ${cityName} ofrecen alquiler de palas por 5 a 10 euros.` },
      { question: `Como encuentro el mejor entrenador de padel en ${cityName}?`, answer: `Compara entrenadores en PadelTrainer.ai por experiencia, resenas y disponibilidad.` },
    ],
    fr: [
      { question: `Combien de clubs de padel y a-t-il a ${cityName}?`, answer: `Il y a actuellement ${clubCount} ${clubCount === 1 ? 'club' : 'clubs'} de padel actifs a ${cityName} et ses environs.` },
      { question: `Combien coute un cours de padel a ${cityName}?`, answer: `Les cours collectifs coutent entre 25 et 50 euros de l'heure. Les cours prives entre 40 et 80 euros.` },
      { question: `Peut-on jouer au padel en interieur a ${cityName}?`, answer: `Oui, la plupart des clubs de ${cityName} proposent des terrains couverts pour jouer toute l'annee.` },
      { question: `Faut-il apporter sa propre raquette?`, answer: `La plupart des clubs de ${cityName} proposent la location de raquettes pour 5 a 10 euros.` },
      { question: `Comment trouver le meilleur coach de padel a ${cityName}?`, answer: `Comparez les entraineurs sur PadelTrainer.ai par experience, avis et disponibilite.` },
    ],
  };
  return faqs[lang] || faqs.en;
}
