import { TrendingUp, TrendingDown, Users, DollarSign, CreditCard, UserCheck, Clock, Building2, UserPlus, ClipboardList } from "lucide-react";
import { StatTile } from "@/components/ui/stat-tile";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { AdminStats } from "@/lib/admin";
import { formatCurrency } from "@/lib/format";

interface AdminStatsCardsProps {
  stats: AdminStats;
}

function TrendBadge({ trend, thisMonth, lastMonth: _lastMonth }: { trend: number; thisMonth: number; lastMonth: number }) {
  const isPositive = trend >= 0;
  return (
    // Spans (with flex classes) rather than divs: this renders inside StatTile's <p> value
    // element, where a div would be invalid p>div nesting (hydration warning).
    <span className="flex items-center gap-1">
      <span className="text-2xl font-bold">{thisMonth}</span>
      <span className={`flex items-center text-xs ${isPositive ? "text-emerald-500" : "text-red-500"}`}>
        {isPositive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
        <span>{Math.abs(trend).toFixed(0)}%</span>
      </span>
    </span>
  );
}

export function AdminStatsCards({ stats }: AdminStatsCardsProps) {
  const navigate = useNavigate();
  const { t } = useTranslation("admin");

  const signupTrends = stats.signupTrends || {
    trainersThisMonth: 0,
    trainersLastMonth: 0,
    trainerTrend: 0,
    playersThisMonth: 0,
    playersLastMonth: 0,
    playerTrend: 0,
  };

  const cards = [
    {
      title: t("stats.gmv"),
      value: formatCurrency(stats.overview.totalGMV),
      description: t("stats.gmvDesc", { count: stats.overview.paidBookings }),
      icon: TrendingUp,
      color: "text-primary",
    },
    {
      title: t("stats.platformFees"),
      value: formatCurrency(stats.overview.platformFees),
      description: t("stats.platformFeesDesc", { amount: stats.overview.avgFeeFlat?.toFixed(2) || '1.00' }),
      icon: DollarSign,
      color: "text-emerald-500",
    },
    {
      title: t("stats.trainerSignups"),
      customValue: (
        <TrendBadge 
          trend={signupTrends.trainerTrend} 
          thisMonth={signupTrends.trainersThisMonth} 
          lastMonth={signupTrends.trainersLastMonth} 
        />
      ),
      description: t("stats.lastMonth", { count: signupTrends.trainersLastMonth }),
      icon: UserPlus,
      color: "text-blue-500",
    },
    {
      title: t("stats.playerSignups"),
      customValue: (
        <TrendBadge 
          trend={signupTrends.playerTrend} 
          thisMonth={signupTrends.playersThisMonth} 
          lastMonth={signupTrends.playersLastMonth} 
        />
      ),
      description: t("stats.lastMonth", { count: signupTrends.playersLastMonth }),
      icon: UserPlus,
      color: "text-violet-500",
    },
    {
      title: t("stats.activeTrainers"),
      value: stats.overview.activeTrainers.toString(),
      description: t("stats.activeTrainersDesc", { count: stats.overview.connectedAccounts }),
      icon: UserCheck,
      color: "text-blue-500",
      onClick: () => navigate("/app/admin/users?role=trainer"),
    },
    {
      title: t("stats.activePlayers"),
      value: stats.overview.activePlayers.toString(),
      description: t("stats.activePlayersDesc", { count: stats.overview.totalBookings }),
      icon: Users,
      color: "text-violet-500",
      onClick: () => navigate("/app/admin/users?role=player"),
    },
    {
      title: t("stats.totalClubs"),
      value: stats.overview.totalClubs?.toString() || "0",
      description: t("stats.totalClubsDesc", { verified: stats.overview.verifiedClubs || 0, subscribed: stats.overview.subscribedClubs || 0 }),
      icon: Building2,
      color: "text-teal-500",
      onClick: () => navigate("/app/admin/clubs"),
    },
    {
      title: t("stats.clubTrials"),
      value: stats.overview.trialingClubs?.toString() || "0",
      description: t("stats.clubTrialsDesc", { count: stats.overview.expiredTrialClubs || 0 }),
      icon: Clock,
      color: "text-amber-500",
    },
    {
      title: t("stats.mollieConnect"),
      value: stats.overview.connectedAccounts.toString(),
      description: t("stats.mollieConnectDesc", { count: stats.overview.pendingAccounts }),
      icon: CreditCard,
      color: "text-orange-500",
    },
    {
      title: t("stats.registrationsLabel"),
      customValue: (
        <TrendBadge
          trend={stats.registrations?.lastMonth > 0
            ? ((stats.registrations.thisMonth - stats.registrations.lastMonth) / stats.registrations.lastMonth) * 100
            : stats.registrations?.thisMonth > 0 ? 100 : 0}
          thisMonth={stats.registrations?.thisMonth || 0}
          lastMonth={stats.registrations?.lastMonth || 0}
        />
      ),
      description: t("stats.registrationsDesc", { total: stats.registrations?.totalGuests || 0, converted: stats.registrations?.convertedToAccount || 0 }),
      icon: ClipboardList,
      color: "text-pink-500",
      onClick: () => navigate("/app/admin/guest-players"),
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <StatTile
          key={card.title}
          label={card.title}
          value={card.customValue ? card.customValue : card.value}
          subtext={card.description}
          icon={card.icon}
          iconClassName={card.color}
          onClick={card.onClick}
        />
      ))}
    </div>
  );
}
