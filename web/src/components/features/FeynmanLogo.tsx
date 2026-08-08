'use client'

import { useState } from 'react'

interface FeynmanLogoProps {
  className?: string
  variant?: 'default' | 'mini' | 'thinking'
  size?: number
}

export function FeynmanLogo({ className = '', variant = 'default', size }: FeynmanLogoProps) {
  const [animationKey, setAnimationKey] = useState(0)

  const handleMouseEnter = () => {
    // Only re-trigger draw animation for non-looping variants
    if (variant !== 'thinking') {
      setAnimationKey((prev) => prev + 1)
    }
  }

  // Set explicit default sizes based on variant
  const defaultSize = variant === 'default' ? 240 : variant === 'mini' ? 48 : 36
  const actualSize = size || defaultSize

  if (variant === 'thinking') {
    return (
      <div 
        className={`inline-flex items-center justify-center animate-sketch-scratch ${className}`}
        style={{ width: actualSize, height: actualSize }}
      >
        <svg 
          viewBox="0 0 400 400" 
          className="w-full h-full"
          xmlns="http://www.w3.org/2000/svg"
        >
          <g stroke="var(--charcoal-graphite, #2C2E33)" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d="M 120 170 Q 140 150 175 165 L 175 220 Q 145 235 120 218 Z"/>
            <ellipse cx="147" cy="165" rx="27" ry="12"/>
            <path d="M 175 178 Q 205 160 240 178 L 240 230 Q 205 245 175 225 Z"/>
            <ellipse cx="207" cy="178" rx="28" ry="12"/>
          </g>
        </svg>
      </div>
    )
  }

  if (variant === 'mini') {
    return (
      <svg 
        key={animationKey}
        viewBox="0 0 400 400" 
        style={{ width: actualSize, height: actualSize }}
        className={`animate-sketch-draw select-none cursor-pointer ${className}`}
        xmlns="http://www.w3.org/2000/svg"
        onMouseEnter={handleMouseEnter}
      >
        <g stroke="var(--charcoal-graphite, #2C2E33)" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M 120 170 Q 140 150 175 165 L 175 220 Q 145 235 120 218 Z"/>
          <ellipse cx="147" cy="165" rx="27" ry="12"/>
          <path d="M 175 178 Q 205 160 240 178 L 240 230 Q 205 245 175 225 Z"/>
          <ellipse cx="207" cy="178" rx="28" ry="12"/>
          <path d="M 90 130 Q 105 155 115 175" strokeWidth="2"/>
          <path d="M 100 120 Q 118 148 128 170" strokeWidth="2"/>
        </g>
      </svg>
    )
  }

  return (
    <div 
      key={animationKey}
      style={{ width: actualSize, height: actualSize }}
      className={`relative inline-flex flex-col items-center select-none cursor-pointer group ${className}`}
      onMouseEnter={handleMouseEnter}
    >
      <svg 
        viewBox="0 0 400 400" 
        className="w-full h-full animate-sketch-draw"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Transparent background so it fits any notebook page context */}
        <g stroke="var(--charcoal-graphite, #2C2E33)" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M 120 170 Q 140 150 175 165 L 175 220 Q 145 235 120 218 Z"/>
          <ellipse cx="147" cy="165" rx="27" ry="12"/>
          <path d="M 175 178 Q 205 160 240 178 L 240 230 Q 205 245 175 225 Z"/>
          <ellipse cx="207" cy="178" rx="28" ry="12"/>
          <path d="M 90 130 Q 105 155 115 175" strokeWidth="1.6"/>
          <path d="M 100 120 Q 118 148 128 170" strokeWidth="1.6"/>
        </g>
        <text 
          x="200" 
          y="290" 
          fontFamily="var(--font-display, Georgia, serif)" 
          fontSize="24" 
          fontStyle="italic"
          fontWeight="semibold"
          fill="var(--charcoal-graphite, #2C2E33)" 
          textAnchor="middle"
          className="transition-colors duration-300 group-hover:fill-fountain-ink"
        >
          Feynman
        </text>
      </svg>
    </div>
  )
}
