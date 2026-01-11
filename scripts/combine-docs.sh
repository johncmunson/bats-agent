#!/bin/bash

# Combine multiple markdown/text files into a single file
# Usage: ./combine-docs.sh [-o output_file] file1 file2 file3 ...
# 
# Options:
#   -o, --output FILE    Output file path (default: merged-docs.md)
#
# Examples:
#   ./combine-docs.sh doc1.md doc2.md doc3.md
#   ./combine-docs.sh -o combined.md doc1.md doc2.md
#   ./combine-docs.sh --output docs/all.md .context/ai-sdk/agents/*.md

set -e

# Default output file
OUTPUT_FILE="merged-docs.md"
INPUT_FILES=()

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -o|--output)
            OUTPUT_FILE="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [-o output_file] file1 file2 file3 ..."
            echo ""
            echo "Options:"
            echo "  -o, --output FILE    Output file path (default: merged-docs.md)"
            echo "  -h, --help           Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0 doc1.md doc2.md doc3.md"
            echo "  $0 -o combined.md doc1.md doc2.md"
            exit 0
            ;;
        -*)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
        *)
            INPUT_FILES+=("$1")
            shift
            ;;
    esac
done

# Check if any input files were provided
if [[ ${#INPUT_FILES[@]} -eq 0 ]]; then
    echo "Error: No input files provided" >&2
    echo "Usage: $0 [-o output_file] file1 file2 file3 ..." >&2
    exit 1
fi

# Clear/create the output file
> "$OUTPUT_FILE"

# Combine files
file_count=0
for i in "${!INPUT_FILES[@]}"; do
    filepath="${INPUT_FILES[$i]}"
    
    if [[ -f "$filepath" ]]; then
        cat "$filepath" >> "$OUTPUT_FILE"
        file_count=$((file_count + 1))
        
        # Add separator between files (except after the last one)
        if [[ $i -lt $((${#INPUT_FILES[@]} - 1)) ]]; then
            # Ensure file content ends with a newline (tail -c 1 is empty after substitution if file ends with newline)
            if [[ -n "$(tail -c 1 "$filepath")" ]]; then
                echo "" >> "$OUTPUT_FILE"
            fi
            
            # Check if file ends with an empty line
            last_line=$(tail -n 1 "$filepath")
            if [[ -z "$last_line" ]]; then
                # File ends with empty line, no need for leading newline
                echo -e "---\n" >> "$OUTPUT_FILE"
            else
                # File doesn't end with empty line, add leading newline
                echo -e "\n---\n" >> "$OUTPUT_FILE"
            fi
        fi
    else
        echo "Warning: File not found: $filepath" >&2
    fi
done

echo "Combined $file_count file(s) into $OUTPUT_FILE"
