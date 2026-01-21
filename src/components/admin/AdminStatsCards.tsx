import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, TrendingDown, Users, DollarSign, CreditCard, UserCheck, Clock, Building2, Shield, UserPlus } from "lucide-react";
import { useNavigate } from "react-router-dom";
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
      title: "Gross Volume (GMV)",
      value: formatCurrency(stats.overview.totalGMV),
      description: `${stats.overview.paidBookings} paid bookings`,
      icon: TrendingUp,
      color: "text-primary",
    },
    {
      title: "Platform Fees",
      value: formatCurrency(stats.overview.platformFees),
      description: `Avg ${stats.overview.avgFeePercent.toFixed(1)}% fee`,
      icon: DollarSign,
      color: "text-emerald-500",
    },
    {
      title: "Trainer Signups",
      customValue: (
        <TrendBadge 
          trend={signupTrends.trainerTrend} 
          thisMonth={signupTrends.trainersThisMonth} 
          lastMonth={signupTrends.trainersLastMonth} 
        />
      ),
      description: `${signupTrends.trainersLastMonth} last month`,
      icon: UserPlus,
      color: "text-blue-500",
    },
    {
      title: "Player Signups",
      customValue: (
        <TrendBadge 
          trend={signupTrends.playerTrend} 
          thisMonth={signupTrends.playersThisMonth} 
          lastMonth={signupTrends.playersLastMonth} 
        />
      ),
      description: `${signupTrends.playersLastMonth} last month`,
      icon: UserPlus,
      color: "text-violet-500",
    },
    {
      title: "Active Trainers",
      value: stats.overview.activeTrainers.toString(),
      description: `${stats.overview.connectedAccounts} connected to Stripe`,
      icon: UserCheck,
      color: "text-blue-500",
      onClick: () => navigate("/admin/users?role=trainer"),
    },
    {
      title: "Active Players",
      value: stats.overview.activePlayers.toString(),
      description: `${stats.overview.totalBookings} total bookings`,
      icon: Users,
      color: "text-violet-500",
      onClick: () => navigate("/admin/users?role=player"),
    },
    {
      title: "Total Clubs",
      value: stats.overview.totalClubs?.toString() || "0",
      description: `${stats.overview.verifiedClubs || 0} verified, ${stats.overview.subscribedClubs || 0} subscribed`,
      icon: Building2,
      color: "text-teal-500",
      onClick: () => navigate("/admin/clubs"),
    },
    {
      title: "Club Trials",
      value: stats.overview.trialingClubs?.toString() || "0",
      description: `${stats.overview.expiredTrialClubs || 0} expired trials`,
      icon: Clock,
      color: "text-amber-500",
    },
    {
      title: "Stripe Connect",
      value: stats.overview.connectedAccounts.toString(),
      description: `${stats.overview.pendingAccounts} pending onboarding`,
      icon: CreditCard,
      color: "text-orange-500",
    },
    {
      title: "Stripe Balance",
      value: stats.stripeBalance?.available?.[0]
        ? formatCurrency(stats.stripeBalance.available[0].amount)
        : "€0.00",
      description: stats.stripeBalance?.pending?.[0]
        ? `${formatCurrency(stats.stripeBalance.pending[0].amount)} pending`
        : "No pending balance",
      icon: Shield,
      color: "text-indigo-500",
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
