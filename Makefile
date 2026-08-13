CC      ?= gcc
PKGS    := sdl2 SDL2_ttf libpulse-simple libpulse
CFLAGS  := -O2 -Wall -Wextra -std=c11 $(shell pkg-config --cflags $(PKGS)) -pthread
LDFLAGS := $(shell pkg-config --libs $(PKGS)) -lm -pthread

SRC := src/main.c src/audio.c src/fft.c src/bars.c src/render.c
OBJ := $(SRC:.c=.o)
BIN := mola

all: $(BIN)

$(BIN): $(OBJ)
	$(CC) $(OBJ) -o $@ $(LDFLAGS)

%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

check-audio: test_capture.c src/audio.c src/fft.c src/bars.c
	$(CC) $(CFLAGS) $^ -o check-audio $(LDFLAGS)

clean:
	rm -f $(OBJ)

fclean: clean
	rm -f $(BIN) check-audio 

re: fclean all

.PHONY: all clean fclean re check-audio
