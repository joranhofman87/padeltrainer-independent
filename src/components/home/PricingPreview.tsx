import { Link } from 'react-router-dom';
import { ArrowRight, Users, Briefcase } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAppUrl } from '@/lib/domains';
import { LocalizedLink } from '@/components/LocalizedLink';

export function PricingPreview() {
  const { t } = useTranslation('marketing');

  return (
    <section id="pricing" className="py-16 md:py-24 lg:py-32 bg-white">
      <div className="max-w-7xl mx-auto px-4 md:px-6">
        <div className="text-center max-w-3xl mx-auto mb-14">
          <span className="eyebrow">{t('homev2.pricing.eyebrow', 'Simple pricing')}</span>
          <h2 className="mt-4 font-display text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-[-0.02em] leading-tight text-navy-900">
            {t('homev2.pricing.headline')}
          </h2>
        </div>

        <div className="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto">
          {/* Players */}
          <div className="card-chip p-8 flex flex-col text-center">
            <div className="w-12 h-12 rounded-xl bg-navy-50 text-navy-700 mx-auto flex items-center justify-center">
              <Users className="h-5 w-5" />
            </div>
            <h3 className="mt-5 font-display font-bold text-xl text-navy-900">
              {t('homev2.pricing.players_title')}
            </h3>
            <p className="mt-3 font-display text-4xl font-extrabold text-navy-900">
              {t('homev2.pricing.players_price')}
            </p>
            <p className="mt-4 text-navy-700">{t('homev2.pricing.players_desc')}</p>
            <p className="mt-2 text-navy-600 text-sm flex-1">{t('homev2.pricing.players_desc2')}</p>
            <Link to={getAppUrl('/signup/player')} className="pill-ghost w-full justify-center mt-6">
              {t('homev2.pricing.players_cta')}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </div>

          {/* Trainers */}
          <div className="card-chip p-8 flex flex-col text-center ring-2 ring-brand-500/40">
            <div className="w-12 h-12 rounded-xl bg-brand-500 text-white mx-auto flex items-center justify-center">
              <Briefcase className="h-5 w-5" />
            </div>
            <h3 className="mt-5 font-display font-bold text-xl text-navy-900">
              {t('homev2.pricing.trainers_title')}
            </h3>
            <p className="mt-3 font-display text-4xl font-extrabold text-navy-900">
              {t('homev2.pricing.trainers_price')}
            </p>
            <p className="mt-4 text-navy-700 flex-1">{t('homev2.pricing.trainers_desc')}</p>
            <Link to={getAppUrl('/signup/trainer')} className="pill-primary w-full justify-center mt-6">
              {t('homev2.cta.startTrial')}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
            <p className="mt-3 text-sm text-navy-600">{t('homev2.pricing.no_cc')}</p>
            <p className="text-sm text-navy-600">{t('homev2.pricing.trainers_microcopy')}</p>
            <LocalizedLink to="/pricing" className="mt-2 text-sm text-brand-700 hover:underline font-medium">
              {t('homev2.pricing.seeAllPlans')}
            </LocalizedLink>
          </div>
        </div>
      </div>
    </section>
  );
}
