import * as React from "react";
import { cn } from "@/lib/utils";

export interface SliderProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  ref?: React.Ref<HTMLInputElement>;
}

export function Slider({ className, ref, ...props }: SliderProps) {
  return (
    <input
      ref={ref}
      type="range"
      className={cn(
        "h-4 w-full cursor-pointer appearance-none bg-transparent accent-primary transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
        // WebKit track + thumb
        "[&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-input",
        "[&::-webkit-slider-thumb]:mt-[-5px] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-hairline",
        // Firefox track + thumb
        "[&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-input",
        "[&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-none [&::-moz-range-thumb]:bg-primary",
        className,
      )}
      {...props}
    />
  );
}
