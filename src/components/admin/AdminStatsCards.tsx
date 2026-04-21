import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, TrendingDown, Users, DollarSign, CreditCard, UserCheck, Clock, Building2, Shield, UserPlus, ClipboardList } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { AdminStats } from "@/lib/admin";

interface AdminStatsCardsProps {
  stats: AdminStats;
}

function TrendBadge({ trend, thisMonth, lastMonth }: { trend: number; thisMonth: number; lastMonth: number }) {
  const isPositive = trend >= 0;
  return (
    <div className="flex items-center gap-1">
      <span className="text-2xl font-bold">{thisMonth}</span>
      <div className={`flex items-center text-xs ${isPositive ? "text-emerald-500" : "text-red-500"}`}>
        {isPositive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
        <span>{Math.abs(trend).toFixed(0)}%</span>
      </div>
    </div>
  );
}

export function AdminStatsCards({ stats }: AdminStatsCardsProps) {
  const navigate = useNavigate();
  const { t } = useTranslation("admin");

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("nl-NL", {
      style: "currency",
      currency: "EUR",
    }).format(amount);
  };

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
        <Card 
          key={card.title} 
          className={card.onClick ? "cursor-pointer hover:bg-muted/50 transition-colors" : ""}
          onClick={card.onClick}
        >
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
            <card.icon className={`h-4 w-4 ${card.color}`} />
          </CardHeader>
          <CardContent>
            {card.customValue ? card.customValue : <div className="text-2xl font-bold">{card.value}</div>}
            <p className="text-xs text-muted-foreground">{card.description}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
