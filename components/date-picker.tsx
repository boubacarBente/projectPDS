'use client';

import { useRef, useState } from 'react';
import DatePickerLib from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';

type DatePickerProps = {
  value: string;
  onChange: (date: string) => void;
  placeholder?: string;
  className?: string;
  selectsRange?: boolean;
  endValue?: string;
  onEndChange?: (date: string) => void;
};

export function DatePicker({ value, onChange, placeholder = 'Sélectionner...', className = '' }: DatePickerProps) {
  const ref = useRef<DatePickerLib>(null);
  const [isOpen, setIsOpen] = useState(false);

  const selectedDate = value ? new Date(value + 'T12:00:00') : null;

  return (
    <div className="relative">
      <DatePickerLib
        ref={ref}
        selected={selectedDate}
        onChange={(date: Date | null) => {
          if (date) {
            const y = date.getFullYear();
            const m = String(date.getMonth() + 1).padStart(2, '0');
            const d = String(date.getDate()).padStart(2, '0');
            onChange(`${y}-${m}-${d}`);
          } else {
            onChange('');
          }
        }}
        dateFormat="dd/MM/yyyy"
        placeholderText={placeholder}
        className={`input input-bordered input-sm text-xs w-full bg-base-100 cursor-pointer ${className}`}
        calendarClassName="custom-calendar"
        popperClassName="custom-popper"
        popperPlacement="bottom-start"
        popperModifiers={[
          {
            name: 'offset',
            options: { offset: [0, 4] },
            fn: () => ({ x: 0, y: 0 }),
          },
          {
            name: 'preventOverflow',
            options: { boundary: 'viewport' as const, padding: 8 },
            fn: () => ({ x: 0, y: 0 }),
          },
        ]}
        onCalendarOpen={() => setIsOpen(true)}
        onCalendarClose={() => setIsOpen(false)}
        wrapperClassName="w-full"
      />
      {/* Calendar icon */}
      <div className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
        {isOpen ? (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 text-base-content/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        )}
      </div>
    </div>
  );
}
