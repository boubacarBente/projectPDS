import { ReactNode } from "react";

type SurfaceCardProps = {
  title: string;
  description?: string;
  children: ReactNode;
};

export function SurfaceCard({
  title,
  description,
  children,
}: SurfaceCardProps) {
  return (
    <section className="rounded-[1.75rem] border border-base-200 bg-base-100/85 p-6 shadow-md shadow-black/5 backdrop-blur">
      <div className="mb-5 space-y-1">
        <h3 className="text-lg font-semibold text-base-content">{title}</h3>
        {description ? (
          <p className="text-sm leading-6 text-base-content/70">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}
