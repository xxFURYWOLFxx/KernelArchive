use std::env;
use std::fs;
use std::process;

fn parse_hex(input: &str) -> Result<Vec<u8>, String> {
    input
        .split_whitespace()
        .map(|part| u8::from_str_radix(part, 16).map_err(|_| format!("invalid hex byte: {part}")))
        .collect()
}

fn count_matches(module: &[u8], pattern: &[u8]) -> usize {
    if pattern.is_empty() || module.len() < pattern.len() {
        return 0;
    }

    module.windows(pattern.len()).filter(|window| *window == pattern).count()
}

fn pattern_string(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect::<Vec<_>>().join(" ")
}

fn best_pattern(module: &[u8], rva: usize, size: usize, window_len: usize) -> Result<(usize, Vec<u8>, usize), String> {
    let end = rva.checked_add(size).ok_or_else(|| "function range overflow".to_string())?;
    let function = module.get(rva..end).ok_or_else(|| "function range is outside module".to_string())?;
    if function.len() < window_len {
        return Err("function is smaller than window length".to_string());
    }

    let mut best: Option<(usize, Vec<u8>, usize)> = None;

    for offset in 0..=function.len() - window_len {
        let candidate = function[offset..offset + window_len].to_vec();
        let collisions = count_matches(module, &candidate).saturating_sub(1);
        if collisions == 0 {
            return Ok((rva + offset, candidate, collisions));
        }
        if best.as_ref().map_or(true, |(_, _, best_collisions)| collisions < *best_collisions) {
            best = Some((rva + offset, candidate, collisions));
        }
    }

    best.ok_or_else(|| "no candidate pattern found".to_string())
}

fn main() {
    let args = env::args().collect::<Vec<_>>();
    if args.len() != 5 {
        eprintln!("usage: kernelarchive-pattern-worker <module-hex-file> <rva> <size> <window-len>");
        process::exit(1);
    }

    let input = match fs::read_to_string(&args[1]) {
        Ok(input) => input,
        Err(error) => {
            eprintln!("{error}");
            process::exit(1);
        }
    };

    let module = match parse_hex(&input) {
        Ok(module) => module,
        Err(error) => {
            eprintln!("{error}");
            process::exit(1);
        }
    };

    let rva = usize::from_str_radix(args[2].trim_start_matches("0x"), 16).unwrap_or_else(|_| args[2].parse().unwrap_or(0));
    let size = args[3].parse::<usize>().unwrap_or(0);
    let window_len = args[4].parse::<usize>().unwrap_or(0);

    match best_pattern(&module, rva, size, window_len) {
        Ok((offset, pattern, collisions)) => {
            let status = if collisions == 0 { "good" } else { "risky" };
            println!(
                "{{\"offset\":\"0x{offset:x}\",\"pattern\":\"{}\",\"mask\":\"{}\",\"length\":{},\"collision_count\":{},\"status\":\"{}\"}}",
                pattern_string(&pattern),
                "x".repeat(pattern.len()),
                pattern.len(),
                collisions,
                status
            );
        }
        Err(error) => {
            eprintln!("{error}");
            process::exit(1);
        }
    }
}
