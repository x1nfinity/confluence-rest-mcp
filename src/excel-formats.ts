/** Bounded common Excel display formats; formulas remain cached data. */
export const MAX_FORMATS = 4096;
export const MAX_FORMAT_LENGTH = 256;
export const BUILTIN_FORMATS: Record<number, string> = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00',
  14: 'mm-dd-yy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM',
  20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yy h:mm', 37: '#,##0;(#,##0)', 38: '#,##0;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 49: '@',
};
type Token = [
  string,
  string
];
type Decimal = {
  coefficient: bigint;
  exponent: number;
  negative: boolean;
};
function fail(reason = 'unsupported'): never {
  throw new Error(reason);
}
const power = (n: number) => 10n ** BigInt(n);
function decimal(raw: string): Decimal {
  if (raw.length > 256 || !/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]{1,4})?$/.test(raw))
    fail('invalid');
  const [mantissa, exp = '0'] = raw.replace(/^[+-]/, '').split(/[eE]/);
  const [whole, fraction = ''] = mantissa.split('.');
  const coefficient = BigInt((whole || '0') + fraction);
  const exponent = Number(exp) - fraction.length;
  const adjusted = coefficient === 0n ? exponent : coefficient.toString().length + exponent - 1;
  if (Math.abs(exponent) > 308 || Math.abs(adjusted) > 308)
    fail('invalid');
  return {
    coefficient, exponent, negative: raw[0] === '-' && coefficient !== 0n
  };
}
function rounded(value: Decimal, places: number): bigint {
  const shift = value.exponent + places;
  if (shift >= 0)
    return value.coefficient * power(shift);
  const divisor = power(-shift);
  return (value.coefficient + divisor / 2n) / divisor;
}
function fixed(value: bigint, places: number): string {
  const digits = value.toString().padStart(places + 1, '0');
  return places ? digits.slice(0, -places) + '.' + digits.slice(-places) : digits;
}
function tokenize(code: string): Token[][] {
  const sections: Token[][] = [];
  let tokens: Token[] = [], offset = 0;
  while (offset < code.length) {
    const char = code[offset];
    if (char === ';') {
      sections.push(tokens);
      tokens = [];
      offset++;
    }
    else if (char === '"' || char === '[') {
      const end = code.indexOf(char === '"' ? '"' : ']', offset + 1);
      if (end < 0)
        fail();
      const item = code.slice(offset + 1, end);
      if (char === '"')
        tokens.push(['literal', item]);
      else if (/^(h{1,2}|m{1,2}|s{1,2})$/i.test(item))
        tokens.push(['elapsed', item.toLowerCase()]);
      else if (!/^(black|blue|cyan|green|magenta|red|white|yellow)$/i.test(item))
        fail();
      offset = end + 1;
    }
    else if (char === '\\') {
      if (offset + 1 === code.length)
        fail();
      tokens.push(['literal', code[offset + 1]]);
      offset += 2;
    }
    else if (char === '_' || char === '*')
      fail();
    else {
      const ampm = /^(AM\/PM|A\/P)/i.exec(code.slice(offset));
      const temporal = /^(y+|m+|d+|h+|s+)/i.exec(code.slice(offset));
      if (ampm) {
        tokens.push(['ampm', ampm[0]]);
        offset += ampm[0].length;
      }
      else if (temporal) {
        tokens.push(['time', temporal[0].toLowerCase()]);
        offset += temporal[0].length;
      }
      else {
        tokens.push(['char', char]);
        offset++;
      }
    }
  }
  sections.push(tokens);
  if (sections.length > 4)
    fail();
  return sections;
}
function numeric(value: Decimal, tokens: Token[], automaticMinus: boolean): string {
  const indexes = tokens.flatMap(([kind, char], i) => kind === 'char' && '0#'.includes(char) ? [i] : []);
  if (!indexes.length) {
    if (tokens.some(([kind, char]) => kind !== 'literal' && (kind !== 'char' || !' -+$€£¥￥()'.includes(char))))
      fail();
    return tokens.map(t => t[1]).join('');
  }
  const start = indexes[0], end = indexes.at(-1)! + 1;
  const pattern = tokens.slice(start, end).map(([kind, char]) => kind === 'char' ? char : '\0').join('');
  const match = /^(0+|#+0|#,##0)(?:\.([0#]+))?(?:([Ee])([+-])(0+))?$/.exec(pattern);
  if (!match)
    fail();
  const before = tokens.slice(0, start), after = tokens.slice(end);
  if ([...before, ...after].some(([kind, char]) => kind !== 'literal' && (kind !== 'char' || !' -+$€£¥￥()%'.includes(char))))
    fail();
  const percent = [...before, ...after].filter(([kind, char]) => kind === 'char' && char === '%').length;
  if (percent > 1)
    fail();
  value = { ...value, exponent: value.exponent + percent * 2 };
  const decimals = match[2] ?? '';
  if (decimals.length > 30 || match[1].length > 64 || (match[5]?.length ?? 0) > 6)
    fail();
  let number: string;
  if (match[3]) {
    if (match[1] !== '0' || decimals.includes('#'))
      fail();
    let exponent = value.coefficient === 0n ? 0 : value.coefficient.toString().length + value.exponent - 1;
    let mantissa = rounded({ ...value, exponent: value.exponent - exponent }, decimals.length);
    if (mantissa >= 10n * power(decimals.length)) {
      mantissa /= 10n;
      exponent++;
    }
    number = fixed(mantissa, decimals.length) + match[3] + (exponent < 0 ? '-' : match[4] === '+' ? '+' : '') + Math.abs(exponent).toString().padStart(match[5].length, '0');
  }
  else {
    number = fixed(rounded(value, decimals.length), decimals.length);
    let [integer, fraction = ''] = number.split('.');
    if (match[1].includes(','))
      integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    else
      integer = integer.padStart([...match[1]].filter(c => c === '0').length, '0');
    const mandatory = decimals.replace(/#+$/, '').length;
    while (fraction.length > mandatory && fraction.endsWith('0'))
      fraction = fraction.slice(0, -1);
    number = integer + (fraction ? '.' + fraction : '');
  }
  return (automaticMinus && value.coefficient !== 0n ? '-' : '') + before.map(t => t[1]).join('') + number + after.map(t => t[1]).join('');
}
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'
];
const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'
];
function temporal(value: Decimal, tokens: Token[], date1904: boolean): [
  string,
  string | null
] {
  const numericValue = Number(value.coefficient) * 10 ** value.exponent;
  if (numericValue < 0 || numericValue >= 2958466)
    fail();
  const semantic = tokens.filter(([kind]) => kind === 'time' || kind === 'elapsed');
  if (!semantic.length || semantic.some(([, code]) => (code[0] === 'y' && ![2, 4].includes(code.length)) || (code[0] === 'm' && code.length > 5) || (code[0] === 'd' && code.length > 4) || ('hs'.includes(code[0]) && code.length > 2)))
    fail();
  const minutes = new Set<number>();
  semantic.forEach(([kind, code], i) => {
    if (kind === 'time' && ['m', 'mm'].includes(code) && (semantic[i - 1]?.[1][0] === 'h' || semantic[i + 1]?.[1][0] === 's'))
      minutes.add(i);
  });
  const hasDate = semantic.some(([kind, code], i) => 'yd'.includes(code[0]) || (code[0] === 'm' && !minutes.has(i) && kind === 'time'));
  if (hasDate && semantic.some(([kind]) => kind === 'elapsed'))
    fail();
  let fractionAt: number | undefined, places = 0;
  tokens.forEach(([kind, code], i) => {
    if (kind === 'char' && '0#?'.includes(code)) {
      if (code !== '0' || i < 2 || tokens[i - 1][0] !== 'char' || tokens[i - 1][1] !== '.' || !['time', 'elapsed'].includes(tokens[i - 2][0]) || tokens[i - 2][1][0] !== 's' || fractionAt !== undefined) {
        if (fractionAt !== undefined && i === fractionAt + places && code === '0') {
          places++;
          return;
        }
        fail();
      }
      fractionAt = i;
      places = 1;
    }
  });
  if (places > 6 || tokens.some(([kind, char]) => kind === 'char' && !' -,/:.0'.includes(char)))
    fail();
  const secondsValue = { ...value, coefficient: value.coefficient * 86400n };
  const scaled = semantic.some(([, code]) => code[0] === 's') ? rounded(secondsValue, places) :
    (secondsValue.exponent >= 0 ? secondsValue.coefficient * power(secondsValue.exponent) : secondsValue.coefficient / power(-secondsValue.exponent)) * power(places);
  const seconds = Number(scaled / power(places)), days = Math.floor(seconds / 86400), hour = Math.floor(seconds % 86400 / 3600), minute = Math.floor(seconds % 3600 / 60), second = seconds % 60;
  const fake = hasDate && !date1904 && days === 60;
  let year = 0, month = 0, day = 0, weekday = 0;
  if (hasDate) {
    if (days === 0 && !date1904)
      fail();
    if (fake) {
      year = 1900;
      month = 2;
      day = 29;
    }
    else {
      const date = new Date((date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31)) + (date1904 || days < 60 ? days : days - 1) * 86400000);
      year = date.getUTCFullYear();
      month = date.getUTCMonth() + 1;
      day = date.getUTCDate();
      weekday = date.getUTCDay();
      if (year > 9999)
        fail();
    }
  }
  const ampm = tokens.some(([kind]) => kind === 'ampm');
  let semanticIndex = 0;
  const output: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const [kind, code] = tokens[i];
    if (i === fractionAt) {
      output.push((scaled % power(places)).toString().padStart(places, '0'));
      i += places - 1;
      continue;
    }
    if (kind === 'time' || kind === 'elapsed') {
      let rendered: string;
      if (kind === 'elapsed')
        rendered = Math.floor(seconds / ({
          h: 3600, m: 60, s: 1
        }[code[0] as 'h' | 'm' | 's'])).toString().padStart(code.length, '0');
      else if (code[0] === 'y')
        rendered = (code.length === 4 ? year : year % 100).toString().padStart(code.length, '0');
      else if (code[0] === 'm' && !minutes.has(semanticIndex))
        rendered = code.length < 3 ? month.toString().padStart(code.length, '0') : code.length === 3 ? MONTHS[month - 1].slice(0, 3) : code.length === 4 ? MONTHS[month - 1] : MONTHS[month - 1][0];
      else if (code[0] === 'd') {
        if (code.length > 2 && fake)
          fail('fake_weekday');
        if (code.length > 2 && !date1904 && days < 60)
          fail();
        rendered = code.length < 3 ? day.toString().padStart(code.length, '0') : code.length === 3 ? WEEKDAYS[weekday].slice(0, 3) : WEEKDAYS[weekday];
      }
      else
        rendered = (code[0] === 'm' ? minute : code[0] === 's' ? second : ampm ? (hour % 12 || 12) : hour).toString().padStart(code.length, '0');
      output.push(rendered);
      semanticIndex++;
    }
    else if (kind === 'ampm') {
      const marker = code.length === 5 ? (hour < 12 ? 'AM' : 'PM') : (hour < 12 ? 'A' : 'P');
      output.push(code === code.toLowerCase() ? marker.toLowerCase() : marker);
    }
    else
      output.push(code);
  }
  let display = output.join('');
  if (hasDate)
    display += ' [date: ' + year.toString().padStart(4, '0') + '-' + month.toString().padStart(2, '0') + '-' + day.toString().padStart(2, '0') + '; system: ' + (date1904 ? '1904' : '1900') + ']';
  return [display, fake ? 'excel_fictitious_leap_day' : null];
}
export function displayNumber(raw: string, code: string | null | undefined, date1904 = false): [
  string,
  string | null
] {
  if (code === 'General')
    return [raw, null];
  const fallback = raw + ' [raw; 格式未还原]';
  if (typeof code !== 'string')
    return [fallback, 'xlsx_number_format_unresolved'];
  if ([...code].length > MAX_FORMAT_LENGTH)
    return [fallback, 'xlsx_number_format_limit'];
  try {
    const value = decimal(raw), sections = tokenize(code);
    const index = value.negative && sections.length > 1 ? 1 : value.coefficient === 0n && sections.length > 2 ? 2 : 0;
    const tokens = sections[index];
    let display: string, warning: string | null = null;
    if (tokens.some(([kind]) => ['time', 'elapsed', 'ampm'].includes(kind))) {
      if (value.negative)
        fail();
      [display, warning] = temporal(value, tokens, date1904);
    }
    else
      display = numeric(value, tokens, value.negative && index === 0);
    if ([...display].length > 1024)
      return [fallback, 'xlsx_number_format_limit'];
    if (!display)
      display = '[格式隐藏值]';
    if (warning === 'excel_fictitious_leap_day')
      display += ' [Excel虚构闰日，非真实公历日期]';
    return [display + ' [raw: ' + raw + ']', warning];
  }
  catch (error) {
    if (error instanceof Error && error.message === 'invalid')
      return [fallback, 'xlsx_numeric_value_limit_or_invalid'];
    if (error instanceof Error && error.message === 'fake_weekday')
      return [fallback + ' [date: 1900-02-29; system: 1900; Excel虚构闰日，非真实公历日期]', 'excel_fictitious_leap_day'];
    return [fallback, 'xlsx_number_format_unsupported'];
  }
}
