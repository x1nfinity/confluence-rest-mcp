// In-memory WinCred ABI fixture. Never loads Windows libraries or accesses an OS credential store.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
typedef struct {
  uint32_t flags, type;
  uint16_t *target, *comment;
  uint32_t written[2], size;
  void *blob;
  uint32_t persist, count;
  void *attributes;
  uint16_t *alias, *user;
} Credential;
static Credential records[8];
static char failure_action;
static uint16_t *failure_target;
static int failure_code, reads, writes, deletes, allocations;
static uint32_t generation;
static char race_action;
static uint16_t *race_trigger, *race_target, *race_user;
static void *race_blob;
static uint32_t race_size;
static int race_remove, race_read_skip;
static int same_stamp;
static size_t length(const uint16_t *s) { size_t n = 0; if (s) while (s[n]) n++; return n; }
static uint16_t *copy(const uint16_t *s) {
  size_t n = (length(s) + 1) * 2; uint16_t *p = malloc(n);
  if (s) memcpy(p, s, n); else memset(p, 0, n); return p;
}
static int equal(const uint16_t *a, const uint16_t *b) {
  if (!a || !b) return a == b;
  return length(a) == length(b) && !memcmp(a, b, length(a) * 2);
}
static void clear(Credential *c) { free(c->target); free(c->comment); free(c->user); free(c->blob); memset(c, 0, sizeof(*c)); }
static void assign(Credential *out, const Credential *in) {
  *out = *in; out->target = copy(in->target); out->comment = copy(in->comment); out->user = copy(in->user);
  out->blob = malloc(in->size); if (in->size) memcpy(out->blob, in->blob, in->size);
}
static int index_of(const uint16_t *target) {
  for (int i = 0; i < 8; i++) if (records[i].target && equal(records[i].target, target)) return i;
  return -1;
}
static int fail(char action, const uint16_t *target) {
  if (action == failure_action && equal(target, failure_target)) { errno = failure_code; return 1; } return 0;
}
void FakeReset(void) {
  for (int i = 0; i < 8; i++) clear(&records[i]); free(failure_target); failure_target = NULL;
  failure_action = 0; reads = writes = deletes = allocations = 0;
  free(race_trigger); free(race_target); free(race_user); free(race_blob);
  race_trigger = race_target = race_user = NULL; race_blob = NULL; race_action = 0;
  generation = 0;
  same_stamp = 0;
}
void FakeFail(int action, const uint16_t *target, int code) {
  failure_action = (char)action; free(failure_target); failure_target = copy(target); failure_code = code;
}
void FakeSeed(const uint16_t *target, const uint16_t *user, void *blob, uint32_t size) {
  int i = index_of(target);
  uint32_t stamp = i < 0 ? 0 : records[i].written[0];
  if (i < 0) { for (i = 0; i < 8 && records[i].target; i++); }
  if (i == 8) abort();
  clear(&records[i]); Credential c = {0}; c.target = (uint16_t *)target; c.user = (uint16_t *)user;
  c.blob = blob; c.size = size; c.type = 1; c.persist = 3;
  c.written[0] = same_stamp && stamp ? stamp : ++generation; assign(&records[i], &c);
}
void FakeSameStamp(void) { same_stamp = 1; }
void FakeRace(int action, const uint16_t *trigger, const uint16_t *target,
              const uint16_t *user, void *blob, uint32_t size) {
  free(race_trigger); free(race_target); free(race_user); free(race_blob);
  race_action = (char)action; race_trigger = copy(trigger); race_target = copy(target); race_user = copy(user);
  race_blob = malloc(size); if (size) memcpy(race_blob, blob, size); race_size = size;
  race_remove = user == NULL; race_read_skip = 0;
}
void FakeRaceAfter(int ordinal) { race_read_skip = ordinal - 1; }
static void race(char action, const uint16_t *trigger) {
  if (race_action == action && equal(trigger, race_trigger)) {
    if (action == 'r' && race_read_skip > 0) { race_read_skip--; return; }
    race_action = 0;
    if (race_remove) { int i = index_of(race_target); if (i >= 0) clear(&records[i]); }
    else FakeSeed(race_target, race_user, race_blob, race_size);
  }
}
int FakeWrites(void) { return writes; }
int FakeReads(void) { return reads; }
int FakeDeletes(void) { return deletes; }
int FakeAllocations(void) { return allocations; }
int FakeSize(const uint16_t *target) { int i = index_of(target); return i < 0 ? -1 : (int)records[i].size; }
void FakeBlob(const uint16_t *target, void *output) {
  int i = index_of(target); if (i < 0) abort(); memcpy(output, records[i].blob, records[i].size);
}
int CredReadW(const uint16_t *target, uint32_t type, uint32_t flags, Credential **value) {
  reads++;
  if (type != 1 || flags) { errno = 87; return 0; }
  if (fail('r', target)) return 0;
  int i = index_of(target); if (i < 0) { errno = 1168; return 0; }
  *value = malloc(sizeof(Credential)); assign(*value, &records[i]); allocations++; race('r', target); return 1;
}
int CredWriteW(Credential *value, uint32_t flags) {
  writes++;
  if (flags || value->type != 1 || value->persist != 3 || value->size > 2560 || value->count || value->attributes) { errno = 87; return 0; }
  if (fail('w', value->target)) return 0;
  FakeSeed(value->target, value->user, value->blob, value->size); return 1;
}
int CredDeleteW(const uint16_t *target, uint32_t type, uint32_t flags) {
  deletes++;
  if (type != 1 || flags) { errno = 87; return 0; }
  if (fail('d', target)) return 0;
  int i = index_of(target); if (i < 0) { errno = 1168; return 0; }
  clear(&records[i]); race('d', target); return 1;
}
void CredFree(Credential *value) { clear(value); free(value); allocations--; }
void SetLastError(uint32_t error) { errno = (int)error; }
