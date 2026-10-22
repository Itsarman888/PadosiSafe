'use strict';

/**
 * Vetted, static "what to do now" guidance.
 * The AI (if enabled) only classifies reports; it never writes safety advice.
 * These are general community tips, not a substitute for emergency services.
 */

const EMERGENCY_NUMBERS = Object.freeze([
  { number: '112', label: 'National emergency number (police, fire, ambulance)' },
  { number: '100', label: 'Police' },
  { number: '101', label: 'Fire brigade' },
  { number: '108', label: 'Emergency ambulance (varies by state)' },
  { number: '1091', label: 'Women helpline' },
  { number: '1098', label: 'Childline' },
  { number: '1906', label: 'LPG gas leak helpline' },
]);

const PLAYBOOKS = Object.freeze({
  fire: [
    'Get everyone out and stay low under smoke. Do not use lifts.',
    'Call 101 (Fire) or 112 now. Give the exact address and a nearby landmark.',
    'For an electrical fire, switch off the mains only if you can reach it safely. Never throw water on it.',
    'Do not go back inside. Keep the lane clear for the fire engine.',
  ],
  gas: [
    'Do not switch any lights, fans or phones on or off, and keep flames away. A spark can ignite gas.',
    'Open doors and windows, close the cylinder regulator if it is safe, and leave the area.',
    'From outside, call the LPG leak helpline 1906 or Fire on 101.',
    'Warn neighbours by knocking. Do not ring electric doorbells.',
  ],
  flood: [
    'Move to higher ground or an upper floor. Never walk or drive through moving water.',
    'If water is near sockets, switch off the mains only if you can do it safely with dry hands.',
    'Pack documents, medicines and a charged phone. Check on elderly neighbours.',
    'Call 112 if anyone needs rescue.',
  ],
  power: [
    'Unplug sensitive appliances to avoid a surge when power returns, and keep the fridge shut.',
    'Never touch fallen or hanging wires. Keep others away and report them to the electricity board or 112.',
    'Check on neighbours who rely on lifts, oxygen or medical devices.',
  ],
  medical: [
    'For serious symptoms call 108 or 112 straight away. Do not wait to see if it passes.',
    'If someone is unresponsive and not breathing normally, start chest compressions if you are trained and send someone to find an AED.',
    'Keep the person still and comfortable. Do not give food or drink to someone who is drowsy.',
  ],
  crime: [
    'Do not confront anyone. Move to a lit, busy place and call 112 or 100.',
    'Note descriptions, direction of travel and vehicle numbers only if it is safe to do so.',
    'Women in distress: 1091. Children: 1098.',
  ],
  accident: [
    'Make the area safe without putting yourself at risk. Use hazard lights and keep traffic away.',
    'Call 108 or 112. Do not move injured people unless there is immediate danger such as fire.',
    'For heavy bleeding, press firmly with a clean cloth and do not remove it.',
  ],
  weather: [
    'Stay indoors, away from windows, trees, hoardings and loose wires.',
    'Charge phones and keep a torch and essentials ready.',
    'Follow advisories from IMD and your local authority.',
  ],
  water: [
    'Store a day of drinking water. Boil water if you suspect contamination.',
    'Report it to your municipal water helpline and tell neighbours.',
    'Check on elderly neighbours and families with infants.',
  ],
  other: [
    'If anyone is in danger, call 112.',
    'Share only what you have seen yourself, and ask a second neighbour to confirm.',
  ],
});

function guidanceFor(category) {
  return PLAYBOOKS[category] || PLAYBOOKS.other;
}

module.exports = { EMERGENCY_NUMBERS, PLAYBOOKS, guidanceFor };
