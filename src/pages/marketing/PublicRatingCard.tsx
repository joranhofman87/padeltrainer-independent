import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Helmet } from 'react-helmet-async';
import { AreaChart, Area, XAxis, YAxis } from 'recharts';
import { format, differenceInMonths } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/Logo';
import { MARKETING_DOMAIN } from '@/lib/domains';
import { supabase } from '@/lib/supabaseClient';
import { Loader2 } from 'lucide-react';

interface PublicRatingData {
  player_name: string;
  rating_system: string;
  system_name: string;
  lower_is_better: boolean;
  history: { rating: number; scraped_at: string }[];
}

export default function PublicRatingCard() {
  const { profileId, lang } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation('common');
  const [data, setData] = useState<PublicRatingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!profileId) return;
    
    const fetchData = async () => {
      try {
        const { data: result, error: err } = await supabase.functions.invoke('get-public-rating', {
          body: { profileId },
        });
        if (err || !result?.history?.length) {
          setError(true);
        } else {
          setData(result);
        }
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [profileId]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#1a1a2e]">
        <Loader2 className="h-8 w-8 animate-spin text-white" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#1a1a2e] text-white gap-4">
        <p className="text-xl">{t('ratingNotFound')}</p>
        <Button onClick={() => navigate(`/${lang || 'nl'}`)}>{t('goToHomepage')}</Button>
      </div>
    );
  }

  const { player_name, history, system_name, lower_is_better } = data;
  const firstName = player_name?.split(' ')[0] || 'Speler';
  const firstRating = history[0].rating;
  const latestRating = history[history.length - 1].rating;
  const rawDiff = Number((firstRating - latestRating).toFixed(2));
  const improvement = lower_is_better ? rawDiff : -rawDiff;

  const bestRating = lower_is_better
    ? Math.min(...history.map(e => e.rating))
    : Math.max(...history.map(e => e.rating));

  const firstDate = new Date(history[0].scraped_at);
  const lastDate = new Date(history[history.length - 1].scraped_at);
  const months = differenceInMonths(lastDate, firstDate);

  const chartData = history.map(entry => ({
    date: format(new Date(entry.scraped_at), "MMM ''yy"),
    rating: entry.rating,
  }));

  const ogTitle = `${firstName}'s Padel Rating: ${latestRating.toFixed(1)} (${improvement > 0 ? '↑' : '↓'}${Math.abs(improvement).toFixed(1)})`;
  const ogDescription = `Van ${firstRating.toFixed(1)} naar ${latestRating.toFixed(1)} in ${months} maanden. Track jouw rating op PadelTrainer.ai`;
  const ogImage = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/rating-og-image?profileId=${profileId}`;

  const getCelebration = () => {
    if (improvement >= 3) return '🚀 Ongelofelijk!';
    if (improvement >= 1) return '📈 Stijgende lijn!';
    if (improvement > 0) return '💪 Stap voor stap beter';
    return '📊 Padel journey';
  };

  return (
    <>
      <Helmet>
        <title>{ogTitle} | PadelTrainer.ai</title>
        <meta name="description" content={ogDescription} />
        <meta property="og:type" content="profile" />
        <meta property="og:title" content={ogTitle} />
        <meta property="og:description" content={ogDescription} />
        <meta property="og:image" content={ogImage} />
        <meta property="og:url" content={`${MARKETING_DOMAIN}/${lang || 'nl'}/rating/${profileId}`} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={ogTitle} />
        <meta name="twitter:description" content={ogDescription} />
        <meta name="twitter:image" content={ogImage} />
      </Helmet>

      <div className="min-h-screen" style={{ background: 'linear-gradient(180deg, #1a1a2e 0%, #16213e 100%)' }}>
        <div className="max-w-lg mx-auto px-4 py-12">
          {/* Logo */}
          <div className="flex justify-center mb-10">
            <Logo variant="dark" className="h-8" />
          </div>

          {/* Card */}
          <div className="bg-white/[0.06] rounded-3xl p-8 backdrop-blur-sm border border-white/[0.08]">
            {/* Name */}
            <div className="text-center mb-8">
              <h1 className="text-3xl font-extrabold text-white mb-1">{firstName}</h1>
              <p className="text-slate-400 text-sm">Padel Rating Journey · {system_name}</p>
            </div>

            {/* Stats */}
            <div className="flex justify-center gap-4 mb-6">
              <div className="bg-white/[0.06] rounded-xl py-4 px-6 text-center">
                <div className="text-3xl font-extrabold text-white tabular-nums">{firstRating.toFixed(1)}</div>
                <div className="text-xs text-slate-400 mt-1">Start</div>
              </div>
              <div className="bg-white/[0.06] rounded-xl py-4 px-6 text-center">
                <div className="text-3xl font-extrabold text-white tabular-nums">{latestRating.toFixed(1)}</div>
                <div className="text-xs text-slate-400 mt-1">Nu</div>
              </div>
            </div>

            {/* Improvement */}
            {improvement !== 0 && (
              <div className="text-center mb-6">
                <span className={`inline-block px-5 py-2 rounded-full text-sm font-semibold ${
                  improvement > 0 
                    ? 'bg-green-500/15 text-green-400 border border-green-500/25' 
                    : 'bg-red-500/15 text-red-400 border border-red-500/25'
                }`}>
                  {getCelebration()} {improvement > 0 ? '+' : ''}{improvement.toFixed(1)} punten
                </span>
              </div>
            )}

            {/* Chart */}
            <div className="bg-white/[0.03] rounded-xl p-4 mb-6">
              <AreaChart data={chartData} width={380} height={200} margin={{ top: 5, right: 10, left: 10, bottom: 20 }}>
                <defs>
                  <linearGradient id="pubGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#F97316" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#F97316" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" fontSize={10} tickLine={false} axisLine={false} stroke="#475569" interval="preserveStartEnd" />
                <YAxis fontSize={10} tickLine={false} axisLine={false} stroke="#475569" domain={['auto', 'auto']} reversed={lower_is_better} width={30} tickFormatter={(v) => v.toFixed(1)} />
                <Area type="monotone" dataKey="rating" stroke="#F97316" strokeWidth={2} fill="url(#pubGrad)" dot={false} />
              </AreaChart>
            </div>

            {/* Time */}
            <p className="text-center text-slate-500 text-xs mb-2">
              {months} maanden progressie
            </p>
          </div>

          {/* CTA */}
          <div className="mt-10 text-center">
            <h2 className="text-xl font-bold text-white mb-2">Track jouw padel rating</h2>
            <p className="text-slate-400 text-sm mb-6">Maak een gratis account aan en volg je voortgang</p>
            <Button
              size="lg"
              className="bg-[#F97316] hover:bg-[#ea6c0e] text-white font-semibold px-8"
              onClick={() => navigate('/app/signup/player')}
            >
              Gratis aanmelden
            </Button>
          </div>

          {/* Footer branding */}
          <div className="mt-12 text-center">
            <Logo variant="dark" className="h-5 mx-auto opacity-50" />
          </div>
        </div>
      </div>
    </>
  );
}
