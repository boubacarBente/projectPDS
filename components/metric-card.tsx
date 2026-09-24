type MetricCardProps = {
  label: string;
  value: string;
  hint: string;
};

export function MetricCard({ label, value, hint }: MetricCardProps) {
  return (
    <div className="rounded-3xl border border-base-200 bg-base-100 p-5 shadow-sm shadow-black/5">
      <p className="text-sm font-medium text-base-content/60">{label}</p>
      <p className="mt-4 text-3xl font-semibold tracking-tight text-base-content">
        {value}
      </p>
      <p className="mt-2 text-sm leading-6 text-base-content/70">{hint}</p>
    </div>
  );
}
