use std::env;
use std::process;

fn escape_json(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn main() {
    let args = env::args().collect::<Vec<_>>();
    if args.len() != 5 {
        eprintln!("usage: kernelarchive-pdb-parser <filename> <guid> <age> <sha256>");
        process::exit(1);
    }

    let age = match args[3].parse::<u32>() {
        Ok(age) => age,
        Err(error) => {
            eprintln!("{error}");
            process::exit(1);
        }
    };

    println!(
        "{{\"filename\":\"{}\",\"guid\":\"{}\",\"age\":{},\"sha256\":\"{}\",\"parse_status\":\"uploaded\"}}",
        escape_json(&args[1]),
        escape_json(&args[2]),
        age,
        escape_json(&args[4])
    );
}

